import net from 'node:net';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MAX_TEXT_BYTES = 16 * 1024;
export const MAX_QUEUE = 100;
const MAX_FRAME = 64 * 1024;
const ID = /^[a-f0-9]{16}$/;
const MODES = ['accept', 'hold', 'refuse'];
const own = stat => stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

function privateDirectory(path) {
  if (process.platform === 'win32') throw new Error('Pi Talk currently requires Unix sockets (macOS or Linux).');
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat)) throw new Error(`Unsafe registry directory: ${path}. Require an owned directory with mode 0700.`);
  return fs.realpathSync(path);
}

function readRecord(directory, id) {
  if (!ID.test(id)) throw new Error('Invalid peer instance ID');
  const fd = fs.openSync(join(directory, `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.size > MAX_FRAME) throw new Error('Unsafe peer registry file');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (record.version !== 1 || record.instanceId !== id || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Invalid peer registry record');
    validateMetadata(record);
    return record;
  } finally { fs.closeSync(fd); }
}

function validateMetadata(info) {
  for (const [key, max] of [['sessionId', 256], ['name', 256], ['description', 2048], ['model', 256], ['cwd', 4096]]) {
    if (typeof info[key] !== 'string' || info[key].length > max) throw new Error(`Invalid peer ${key}`);
  }
  if (!['busy', 'idle'].includes(info.state)) throw new Error('Invalid peer state');
  if (!Array.isArray(info.swarms) || info.swarms.length > 32 || info.swarms.some(s => typeof s !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(s))) {
    throw new Error('Swarm names must use 1–64 letters, digits, hyphens, or underscores (maximum 32 swarms).');
  }
}

function publicRecord(record) {
  const { token, ...info } = record;
  return info;
}

function socketPath(directory, id) { return join(directory, `${id}.sock`); }

function abortError(signal) {
  const error = new Error('Operation cancelled', { cause: signal?.reason });
  error.name = 'AbortError';
  return error;
}
function checkCancelled(signal) { if (signal?.aborted) throw abortError(signal); }

// One bounded JSON line per connection; partial frames cannot hold a connection indefinitely.
function readLine(socket, callback) {
  let buffer = Buffer.alloc(0);
  const onData = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME) { socket.destroy(new Error('Frame size limit exceeded')); return; }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    socket.removeListener('data', onData);
    try { callback(null, JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
    catch (error) { callback(error); }
  };
  socket.on('data', onData);
}

function exchange(directory, record, request, timeout, connections, signal) {
  return new Promise((resolveResult, reject) => {
    let socket;
    let sent = false;
    let done = false;
    let deadline;
    const finish = (error, response) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      connections?.delete(socket);
      socket?.destroy();
      if (error) { error.uncertain = sent; reject(error); } else resolveResult(response);
    };
    const onAbort = () => finish(abortError(signal));
    try {
      checkCancelled(signal);
      signal?.addEventListener('abort', onAbort, { once: true });
      const frame = `${JSON.stringify({ ...request, token: record.token })}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME) throw Object.assign(new Error('Wire frame size limit exceeded'), { code: 'EMSGSIZE' });
      const path = socketPath(directory, record.instanceId);
      const stat = fs.lstatSync(path);
      if (!stat.isSocket() || !own(stat)) throw new Error('Unsafe peer socket');
      socket = net.createConnection(path);
      connections?.add(socket);
      socket.once('close', () => { connections?.delete(socket); finish(new Error('Peer connection closed')); });
      deadline = setTimeout(() => finish(new Error('Peer timed out')), timeout);
      socket.once('error', error => finish(error));
      socket.once('connect', () => {
        if (signal?.aborted) { onAbort(); return; }
        sent = true;
        socket.write(frame);
      });
      readLine(socket, (error, response) => {
        if (error) return finish(error);
        if (response?.instanceId !== record.instanceId) return finish(new Error('Peer identity mismatch'));
        finish(null, response);
      });
    } catch (error) { finish(error); }
  });
}

export class Peer {
  static async start(metadata, options = {}) {
    const peer = new Peer(metadata, options);
    try { await peer.open(); return peer; }
    catch (error) { await peer.close(); throw error; }
  }

  constructor(metadata, options) {
    validateMetadata(metadata);
    this.directory = privateDirectory(resolve(options.directory ?? process.env.PI_TALK_DIR ?? join(homedir(), '.pi/agent/pi-talk/peers')));
    this.record = { ...metadata, swarms: [...new Set(metadata.swarms)], version: 1, instanceId: randomBytes(8).toString('hex'), pid: process.pid, token: randomBytes(32).toString('hex') };
    this.path = socketPath(this.directory, this.record.instanceId);
    if (Buffer.byteLength(this.path) > 103) throw new Error('Socket path is too long. Set PI_TALK_DIR to a shorter private directory.');
    this.timeout = options.timeout ?? 1000;
    this.maxQueue = options.maxQueue ?? MAX_QUEUE;
    this.inbound = 'accept';
    this.queue = [];
    this.connections = new Set();
    this.lifecycle = new AbortController();
    this.closed = false;
    this.onError = options.onError ?? (() => {});
  }

  get info() { return structuredClone(publicRecord(this.record)); }
  get pending() { return this.queue.length; }

  async open() {
    // Publish the owner before binding so a crash cannot leave an ownerless socket.
    this.publish();
    this.server = net.createServer(socket => this.accept(socket));
    this.server.maxConnections = 64;
    await new Promise((resolveOpen, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, () => { this.server.removeListener('error', reject); resolveOpen(); });
    });
    this.server.on('error', error => this.onError(error));
    fs.chmodSync(this.path, 0o600);
    this.server.unref();
  }

  publish() {
    const file = join(this.directory, `${this.record.instanceId}.json`);
    const temporary = join(this.directory, `${this.record.instanceId}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...this.record, socket: this.path }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  async update(patch) {
    if (this.closed) throw new Error('Peer is closed');
    const allowed = ['name', 'description', 'model', 'cwd', 'swarms', 'state'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Cannot change peer identity');
    const next = { ...this.record, ...patch };
    validateMetadata(next);
    const previous = this.record;
    this.record = { ...next, swarms: [...new Set(next.swarms)] };
    try { this.publish(); } catch (error) { this.record = previous; throw error; }
  }

  accept(socket) {
    this.connections.add(socket);
    socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), this.timeout);
    socket.once('close', () => { clearTimeout(deadline); this.connections.delete(socket); });
    readLine(socket, (error, request) => {
      let result;
      try {
        if (error) throw error;
        if (this.closed || request?.token !== this.record.token) throw new Error('Peer authentication failed');
        result = request.op === 'ping' ? { status: 'alive' } : this.receive(request);
      } catch (failure) { result = { status: 'rejected', reason: failure.message }; }
      socket.end(`${JSON.stringify({ ...result, instanceId: this.record.instanceId })}\n`);
    });
  }

  receive(request) {
    if (request.op !== 'message') throw new Error('Unknown peer operation');
    const sender = readRecord(this.directory, request.senderId);
    if (sender.token !== request.senderToken || !alive(sender.pid)) throw new Error('Sender authentication failed');
    this.validateText(request.text);
    if (typeof request.messageId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.messageId)) throw new Error('Invalid message ID');
    if (request.swarm !== undefined && (!this.record.swarms.includes(request.swarm) || !sender.swarms.includes(request.swarm))) throw new Error('Both peers must be swarm members');
    const base = { messageId: request.messageId };
    if (this.inbound === 'refuse') return { ...base, status: 'refused' };
    if (this.queue.length >= this.maxQueue) return { ...base, status: 'full' };
    this.queue.push({ id: request.messageId, sender: publicRecord(sender), replyTo: sender.instanceId, text: request.text, swarm: request.swarm, timestamp: new Date().toISOString() });
    return { ...base, status: this.inbound === 'hold' ? 'held' : 'queued' };
  }

  validateText(text) {
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error(`Message size must be 1–${MAX_TEXT_BYTES} UTF-8 bytes of nonblank text`);
  }

  setInbound(mode) {
    if (!MODES.includes(mode)) throw new Error('Inbound mode must be accept, hold, or refuse');
    this.inbound = mode;
    const discarded = mode === 'refuse' ? this.queue.splice(0).length : 0;
    return { mode, discarded, pending: this.pending };
  }

  drain(limit = MAX_QUEUE) {
    return this.inbound === 'accept' ? this.queue.splice(0, limit) : [];
  }

  async list(options) { return (await this.discover(options)).peers; }

  async discover({ signal } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    checkCancelled(signal);
    const peers = [], unavailable = [];
    for (const name of fs.readdirSync(this.directory).sort()) {
      checkCancelled(signal);
      this.cleanupTemporary(name);
      if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      if (id === this.record.instanceId) continue;
      let record;
      try {
        record = readRecord(this.directory, id);
        const response = await exchange(this.directory, record, { op: 'ping' }, this.timeout, this.connections, signal);
        checkCancelled(signal);
        if (response.status !== 'alive') throw new Error('Peer did not confirm its identity');
        peers.push(publicRecord(record));
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (record && ['ENOENT', 'ECONNREFUSED'].includes(error.code) && !alive(record.pid)) { this.cleanupStale(record); continue; }
        if (record) unavailable.push({ ...publicRecord(record), status: 'unavailable', reason: error.message });
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) this.onError(new Error(`Peer ${id} excluded: ${error.message}`));
      }
    }
    return { peers, unavailable };
  }

  cleanupTemporary(name) {
    const match = name.match(/^[a-f0-9]{16}\.([1-9][0-9]*)\.tmp$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || alive(Number(match[1]))) return;
    try {
      const path = join(this.directory, name);
      const stat = fs.lstatSync(path);
      if (stat.isFile() && own(stat)) fs.unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
  }

  cleanupStale(record) {
    try {
      const current = readRecord(this.directory, record.instanceId);
      if (current.token !== record.token || alive(current.pid)) return;
      const path = socketPath(this.directory, record.instanceId);
      try {
        const stat = fs.lstatSync(path);
        if (!stat.isSocket() || !own(stat)) return;
        fs.unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.unlinkSync(join(this.directory, `${record.instanceId}.json`));
    } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
  }

  async send(target, text, swarm, { signal } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    checkCancelled(signal);
    this.validateText(text);
    let record;
    if (ID.test(target)) {
      try { record = readRecord(this.directory, target); }
      catch (error) { if (error.code === 'ENOENT') throw new Error(`Peer unavailable: ${target}`); throw error; }
    } else {
      const discovery = await this.discover({ signal });
      const peers = [...discovery.peers, ...discovery.unavailable].filter(peer => peer.name === target);
      checkCancelled(signal);
      if (peers.length > 1) throw new Error(`Ambiguous peer name: ${target}. Use an instanceId.`);
      if (peers.length === 0) throw new Error(`Peer unavailable: ${target}`);
      record = readRecord(this.directory, peers[0].instanceId);
    }
    if (record.instanceId === this.record.instanceId) throw new Error('Cannot message this same instance');
    return this.sendRecord(record, text, swarm, signal);
  }

  async sendRecord(record, text, swarm, signal) {
    checkCancelled(signal);
    const messageId = randomUUID();
    try {
      const response = await exchange(this.directory, record, { op: 'message', messageId, text, swarm, senderId: this.record.instanceId, senderToken: this.record.token }, this.timeout, this.connections, signal);
      if (!['queued', 'held', 'refused', 'full', 'rejected'].includes(response.status)) throw new Error('Invalid peer receipt');
      return { ...response, messageId };
    } catch (error) {
      if (error.name === 'AbortError') {
        error.message += `: message ${messageId} to ${record.instanceId}; delivery ${error.uncertain ? 'uncertain, do not retry blindly' : 'not attempted'}.`;
        throw error;
      }
      return { instanceId: record.instanceId, messageId, status: error.code === 'EMSGSIZE' ? 'rejected' : error.uncertain ? 'uncertain' : 'unavailable', reason: error.message };
    }
  }

  async broadcast(swarm, text, { signal } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    checkCancelled(signal);
    this.validateText(text);
    if (!this.record.swarms.includes(swarm)) throw new Error('Join the swarm before broadcasting as a member');
    const discovery = await this.discover({ signal });
    const members = discovery.peers.filter(peer => peer.swarms.includes(swarm));
    const results = discovery.unavailable.filter(peer => peer.swarms.includes(swarm))
      .map(peer => ({ instanceId: peer.instanceId, status: 'unavailable', reason: peer.reason }));
    for (const member of members) {
      try {
        checkCancelled(signal);
        results.push(await this.send(member.instanceId, text, swarm, { signal }));
      } catch (error) {
        if (error.name === 'AbortError') {
          error.receipts = results;
          error.message += ` Completed receipts: ${JSON.stringify(results)}`;
          throw error;
        }
        results.push({ instanceId: member.instanceId, status: 'unavailable', reason: error.message });
      }
    }
    return results;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifecycle.abort();
    this.queue = [];
    this.closing = (async () => {
      for (const socket of this.connections) socket.destroy();
      if (this.server?.listening) await new Promise(resolveClose => this.server.close(resolveClose));
      // net.Server removes its socket on close; remove only this instance's registry.
      const file = join(this.directory, `${this.record.instanceId}.json`);
      try { if (readRecord(this.directory, this.record.instanceId).token === this.record.token) fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
    })();
    return this.closing;
  }
}
