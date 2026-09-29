import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, chmod, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Peer } from '../src/transport.js';

const meta = (name) => ({ sessionId: name, name, description: `${name} work`, model: 'test/model', cwd: '/work', swarms: [], state: 'idle' });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pt-'));
  const peers = [];
  t.after(async () => { await Promise.all(peers.map(p => p.close())); await rm(directory, { recursive: true, force: true }); });
  return { directory, async peer(name, options = {}) { const peer = await Peer.start(meta(name), { directory, ...options }); peers.push(peer); return peer; } };
}

test('independent peers discover and send without joining a swarm', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  const peers = await a.list();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].name, 'b');
  assert.equal(peers[0].token, undefined);
  const receipt = await a.send(b.info.instanceId, 'hello');
  assert.equal(receipt.status, 'queued');
  const [message] = b.drain();
  assert.equal(message.text, 'hello');
  assert.equal(message.sender.name, 'a');
  assert.equal(message.replyTo, a.info.instanceId);
  assert.equal(message.id, receipt.messageId);
  assert.deepEqual(b.drain(), []);
  await b.close();
  assert.deepEqual(await a.list(), []);
  await a.close();
  assert.deepEqual(await readdir(f.directory), []);
});

test('hold, refuse, and bounded queues have explicit outcomes', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b', { maxQueue: 1 });
  b.setInbound('hold');
  assert.equal((await a.send('b', 'held')).status, 'held');
  assert.deepEqual(b.drain(), []);
  assert.equal((await a.send('b', 'full')).status, 'full');
  b.setInbound('accept');
  assert.equal(b.drain()[0].text, 'held');
  b.setInbound('refuse');
  assert.equal((await a.send('b', 'no')).status, 'refused');
  assert.throws(() => b.setInbound('wrong'), /inbound/i);
});

test('broadcasts reach members only and ambiguous names never resolve', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b'), c = await f.peer('c');
  await a.update({ swarms: ['team'] }); await b.update({ swarms: ['team'] });
  const results = await a.broadcast('team', 'news');
  assert.equal(results.length, 1); assert.equal(results[0].status, 'queued');
  assert.equal(b.drain()[0].swarm, 'team'); assert.deepEqual(c.drain(), []);
  await c.update({ name: 'b' });
  await assert.rejects(a.send('b', 'ambiguous'), /ambiguous/i);
  await assert.rejects(a.broadcast('other', 'no'), /member/i);
  await assert.rejects(a.send('missing', 'no'), /unavailable/i);
  await assert.rejects(a.send(b.info.instanceId, 'x'.repeat(17000)), /size/i);
});

test('messages cross processes and discovery cleans confirmed crash leftovers', async t => {
  const f = await setup(t), a = await f.peer('a');
  const child = fork(new URL('./fixtures/peer.mjs', import.meta.url), [f.directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill());
  const [info] = await once(child, 'message');
  assert.equal((await a.send(info.instanceId, 'cross process')).status, 'queued');
  const delivered = once(child, 'message'); child.send('drain');
  const [messages] = await delivered;
  assert.equal(messages[0].text, 'cross process');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.ok((await readdir(f.directory)).includes(`${info.instanceId}.json`));
  await writeFile(join(f.directory, `${info.instanceId}.${info.pid}.tmp`), 'partial write', { mode: 0o600 });
  assert.deepEqual(await a.list(), []);
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith(info.instanceId)));
});

test('unsafe directories and symlinked socket targets are refused', async t => {
  const f = await setup(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.peer('unsafe'), /unsafe registry/i);
  await chmod(f.directory, 0o700);
  const a = await f.peer('a'), b = await f.peer('b');
  const bPath = join(f.directory, `${b.info.instanceId}.sock`);
  await rm(bPath); await symlink(join(f.directory, `${a.info.instanceId}.sock`), bPath);
  const result = await a.send(b.info.instanceId, 'unsafe');
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /unsafe peer socket/i);
  assert.deepEqual(a.drain(), []);
});

test('unreachable registration of a live process is preserved', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  await rm(join(f.directory, `${b.info.instanceId}.sock`));
  assert.deepEqual(await a.list(), []);
  assert.ok((await lstat(join(f.directory, `${b.info.instanceId}.json`))).isFile());
});

test('unreachable peers still prevent ambiguous names and receive broadcast result rows', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('duplicate'), c = await f.peer('duplicate');
  for (const peer of [a, b, c]) await peer.update({ swarms: ['team'] });
  await rm(join(f.directory, `${b.info.instanceId}.sock`));
  await assert.rejects(a.send('duplicate', 'do not guess'), /ambiguous/i);
  assert.deepEqual(c.drain(), []);
  const discovery = await a.discover();
  assert.equal(discovery.unavailable[0].instanceId, b.info.instanceId);
  const receipts = await a.broadcast('team', 'news');
  assert.equal(receipts.length, 2);
  assert.equal(receipts.find(r => r.instanceId === b.info.instanceId).status, 'unavailable');
  assert.equal(receipts.find(r => r.instanceId === c.info.instanceId).status, 'queued');
});

test('partial connections have an absolute deadline and a concurrency limit', async t => {
  const f = await setup(t), b = await f.peer('b', { timeout: 80 });
  assert.equal(b.server.maxConnections, 64);
  const socket = net.createConnection(join(f.directory, `${b.info.instanceId}.sock`));
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  const timer = setInterval(() => socket.write(' '), 10);
  t.after(() => clearInterval(timer));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Connection outlived deadline')), 500).unref())]);
  clearInterval(timer);
});

test('metadata validation and registry permissions protect discovery', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  await assert.rejects(b.update({ swarms: ['bad/name'] }), /swarm/i);
  await assert.rejects(b.update({ pid: 10 }), /identity/i);
  const file = join(f.directory, `${b.info.instanceId}.json`);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644);
  assert.deepEqual(await a.list(), []);
  await chmod(file, 0o600);
});

test('JSON expansion cannot turn an oversized wire frame into uncertain delivery', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  const receipt = await a.send(b.info.instanceId, '\u0000'.repeat(12000));
  assert.equal(receipt.status, 'rejected');
  assert.match(receipt.reason, /frame size/i);
  assert.deepEqual(b.drain(), []);
});

test('wire authentication rejects a forged sender before queueing', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  const record = JSON.parse(await readFile(join(f.directory, `${b.info.instanceId}.json`), 'utf8'));
  const socket = net.createConnection(join(f.directory, `${b.info.instanceId}.sock`));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const response = once(socket, 'data');
  socket.write(`${JSON.stringify({ op: 'message', token: record.token, senderId: a.info.instanceId, senderToken: 'wrong', text: 'forged' })}\n`);
  const [data] = await response;
  assert.equal(JSON.parse(data).status, 'rejected'); assert.deepEqual(b.drain(), []);
});

test('a missing receipt is uncertain and is not retried', async t => {
  const f = await setup(t), a = await f.peer('a', { timeout: 40 });
  const id = '0123456789abcdef', path = join(f.directory, `${id}.sock`);
  let requests = 0;
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('data', () => requests++); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(f.directory, `${id}.json`), JSON.stringify({ ...meta('no-receipt'), instanceId: id, version: 1, pid: process.pid, token: 'a'.repeat(64) }), { mode: 0o600 });
  assert.equal((await a.send(id, 'one attempt')).status, 'uncertain'); assert.equal(requests, 1);
});

test('aborting discovery closes the pending probe without waiting for its timeout', async t => {
  const f = await setup(t), a = await f.peer('a', { timeout: 3000 });
  const id = '0000000000000000', path = join(f.directory, `${id}.sock`);
  const controller = new AbortController();
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => controller.abort());
  });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(f.directory, `${id}.json`), JSON.stringify({ ...meta('slow'), instanceId: id, version: 1, pid: process.pid, token: 'a'.repeat(64) }), { mode: 0o600 });
  const started = Date.now();
  await assert.rejects(a.list({ signal: controller.signal }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 1000, 'cancellation should not wait for the 3-second peer timeout');
  assert.equal(a.connections.size, 0);
});

test('aborted broadcast stops before later recipients and marks the attempted delivery uncertain', async t => {
  const f = await setup(t), a = await f.peer('a', { timeout: 3000 }), b = await f.peer('later');
  await a.update({ swarms: ['team'] }); await b.update({ swarms: ['team'] });
  const id = '0000000000000000', path = join(f.directory, `${id}.sock`);
  const controller = new AbortController();
  const sockets = new Set();
  let attempts = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => {
      const request = JSON.parse(data);
      if (request.op === 'ping') socket.end(`${JSON.stringify({ instanceId: id, status: 'alive' })}\n`);
      else { attempts++; controller.abort(); }
    });
  });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(f.directory, `${id}.json`), JSON.stringify({ ...meta('first'), swarms: ['team'], instanceId: id, version: 1, pid: process.pid, token: 'a'.repeat(64) }), { mode: 0o600 });
  await assert.rejects(a.broadcast('team', 'cancel me', { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError'); assert.match(error.message, /uncertain/i); return true;
  });
  assert.equal(attempts, 1); assert.deepEqual(b.drain(), []);
});

test('already-aborted operations send nothing and peer close cancels discovery', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  await a.update({ swarms: ['team'] }); await b.update({ swarms: ['team'] });
  const signal = AbortSignal.abort();
  await assert.rejects(a.list({ signal }), { name: 'AbortError' });
  await assert.rejects(a.send('b', 'no', undefined, { signal }), { name: 'AbortError' });
  await assert.rejects(a.broadcast('team', 'no', { signal }), { name: 'AbortError' });
  assert.deepEqual(b.drain(), []);
  const listing = a.list(); await a.close();
  await assert.rejects(listing, { name: 'AbortError' });
  assert.equal(a.connections.size, 0);
});

test('refuse discards held messages and never releases them later', async t => {
  const f = await setup(t), a = await f.peer('a'), b = await f.peer('b');
  b.setInbound('hold'); await a.send('b', 'held');
  assert.equal(b.setInbound('refuse').discarded, 1);
  b.setInbound('accept'); assert.deepEqual(b.drain(), []);
});
