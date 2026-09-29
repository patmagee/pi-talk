import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from '../src/extension.js';
import { Peer } from '../src/transport.js';

export async function verifyInstalledQueue(directory) {
  const cli = realpathSync(execFileSync('which', [process.env.PI_BIN || 'pi'], { encoding: 'utf8' }).trim());
  let packageRoot = dirname(cli);
  while (!existsSync(join(packageRoot, 'package.json'))) {
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new Error('Cannot locate the installed Pi package from PI_BIN');
    packageRoot = parent;
  }
  const { AgentSession } = await import(pathToFileURL(join(packageRoot, 'dist/core/agent-session.js')));
  // Use Pi's actual custom-message method and pending-count getter. Only the agent is a test double.
  const session = Object.create(AgentSession.prototype);
  Object.defineProperty(session, 'isStreaming', { value: true });
  session._steeringMessages = [];
  session._followUpMessages = [];
  const queued = [];
  session.agent = { steer: message => queued.push(message) };
  const handlers = new Map();
  let tick;
  const ctx = { cwd: process.cwd(), model: { provider: 'test', id: 'queue' }, hasUI: false,
    isIdle: () => false, hasPendingMessages: () => session.pendingMessageCount > 0,
    sessionManager: { getSessionId: () => 'queue-session', getBranch: () => [] } };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerFlag() {}, registerTool() {}, registerCommand() {},
    getFlag() {}, getSessionName: () => 'queue-session',
    sendMessage: (message, options) => { void session.sendCustomMessage(message, options); } };
  install(pi, {}, { directory, setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval() {} });
  let probe;
  try {
    await handlers.get('session_start')({}, ctx);
    probe = await Peer.start({ sessionId: 'queue-probe', name: 'queue-probe', description: '', model: 'test/probe', cwd: process.cwd(), swarms: [], state: 'idle' }, { directory });
    await probe.send('queue-session', 'first'); await probe.send('queue-session', 'second');
    tick();
    assert.equal(session.pendingMessageCount, 0, 'Installed Pi does not count custom steering messages in this getter');
    tick(); tick();
    assert.equal(queued.length, 1, 'Pi Talk must independently bound outstanding custom messages');
    handlers.get('message_start')({ message: queued.shift() }, ctx);
    tick(); assert.equal(queued.length, 1);
    assert.match(queued[0].content, /second/);
  } finally {
    await handlers.get('session_shutdown')({}, ctx); await probe?.close();
  }
}
