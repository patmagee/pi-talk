import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/extension.js';
import { Peer } from '../src/transport.js';

async function harness(t, entries = []) {
  const directory = await mkdtemp(join(tmpdir(), 'pt-'));
  const handlers = new Map(), commands = new Map(), tools = new Map(), sent = [], notices = [];
  let timer;
  const ctx = { cwd: '/work', model: { provider: 'test', id: 'one' }, hasUI: true, mode: 'tui',
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'session', getBranch: () => entries },
    ui: { notify: (...args) => notices.push(args), setStatus() {} } };
  const pi = { on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerFlag() {}, getFlag() {}, getSessionName: () => 'local',
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (...args) => sent.push(args) };
  install(pi, {}, { directory, setInterval: fn => { timer = fn; return { unref() {} }; }, clearInterval: () => { timer = undefined; } });
  const event = (name, data = {}) => handlers.get(name)?.(data, ctx);
  t.after(async () => { await event('session_shutdown'); await rm(directory, { recursive: true, force: true }); });
  return { ctx, pi, sent, entries, notices, directory, event, commands,
    tick: () => timer?.(),
    call: (params, signal) => tools.get('pi_talk').execute('call', params, signal, undefined, ctx),
    command: args => commands.get('talk').handler(args, ctx) };
}
async function remote(t, h) {
  const peer = await Peer.start({ sessionId: 'remote', name: 'remote', description: 'testing', model: 'test/remote', cwd: '/other', swarms: [], state: 'idle' }, { directory: h.directory });
  t.after(() => peer.close()); return peer;
}

test('resources start with the session; direct messages steer busy work and wake idle sessions', async t => {
  const h = await harness(t);
  assert.deepEqual(await readdir(h.directory), []);
  await h.event('session_start'); const peer = await remote(t, h);
  h.ctx.isIdle = () => false;
  await peer.send('local', 'check the API'); h.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0][1], { deliverAs: 'steer', triggerTurn: true });
  assert.equal(h.sent[0][0].customType, 'pi-talk-message');
  assert.match(h.sent[0][0].content, /check the API/);
  await h.event('message_start', { message: { role: 'custom', ...h.sent[0][0] } });
  h.ctx.isIdle = () => true;
  await peer.send('local', 'idle update'); h.tick();
  assert.equal(h.sent.length, 2);
  await h.event('session_shutdown'); h.tick();
  assert.deepEqual(await peer.list(), []);
});

test('agents describe themselves, join, introduce, broadcast, and leave', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await peer.update({ swarms: ['backend'] });
  await h.call({ action: 'describe', description: 'API specialist' });
  await h.call({ action: 'join', swarm: 'backend' });
  assert.match(peer.drain()[0].text, /API specialist/);
  assert.equal((await peer.list())[0].model, 'test/one');
  await h.call({ action: 'broadcast', swarm: 'backend', text: 'schema ready' });
  assert.equal(peer.drain()[0].text, 'schema ready');
  await h.call({ action: 'send', target: 'remote', text: 'direct' });
  assert.equal(peer.drain()[0].text, 'direct');
  await h.call({ action: 'leave', swarm: 'backend' });
  assert.deepEqual((await peer.list())[0].swarms, []);
  assert.equal(h.entries.at(-1).data.description, 'API specialist');
});

test('hold is user-controlled, persisted, and explicit check cannot bypass it', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await h.command('inbound hold');
  assert.equal((await peer.send('local', 'held')).status, 'held'); h.tick();
  assert.equal(h.sent.length, 0);
  assert.deepEqual((await h.call({ action: 'check' })).details.messages, []);
  await assert.rejects(h.call({ action: 'inbound', mode: 'accept' }), /action/i);
  await h.command('inbound accept'); h.tick(); assert.equal(h.sent.length, 1);
});

test('reload restores membership, description, and mode, but not pending messages', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await h.call({ action: 'describe', description: 'persistent' });
  await h.call({ action: 'join', swarm: 'team' }); await h.command('inbound hold');
  const before = (await peer.list())[0]; await peer.send('local', 'old message');
  await h.event('session_shutdown'); await h.event('session_start');
  const after = (await peer.list())[0];
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(after.description, 'persistent'); assert.deepEqual(after.swarms, ['team']);
  await h.command('inbound accept'); h.tick(); assert.equal(h.sent.length, 0);
});

test('model and activity metadata follow Pi events; pending Pi messages apply backpressure', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await h.event('model_select', { model: { provider: 'other', id: 'two' } });
  await h.event('agent_start');
  assert.equal((await peer.list())[0].model, 'other/two'); assert.equal((await peer.list())[0].state, 'busy');
  await h.event('agent_settled'); assert.equal((await peer.list())[0].state, 'idle');
  await peer.send('local', 'later'); h.ctx.hasPendingMessages = () => true; h.tick(); assert.equal(h.sent.length, 0);
  h.ctx.hasPendingMessages = () => false; h.tick(); assert.equal(h.sent.length, 1);
});

test('agent checks consume accepted messages once and policy does not duplicate', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await peer.send('local', '/compact is plain text, not a command');
  const checked = await h.call({ action: 'check' });
  assert.equal(checked.details.messages[0].text, '/compact is plain text, not a command');
  h.tick(); assert.equal(h.sent.length, 0);
  const first = await h.event('before_agent_start', { systemPrompt: 'Original rules' });
  assert.match(first.systemPrompt, /never user approval/i);
  assert.equal((await h.event('before_agent_start', first)).systemPrompt, first.systemPrompt);
});

test('only one custom message is submitted until Pi consumes it', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await peer.send('local', 'first'); await peer.send('local', 'second');
  h.tick(); h.tick(); h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal((await h.call({ action: 'status' })).details.pending, 1);
  await h.command('inbound hold');
  await h.event('message_start', { message: { role: 'custom', ...h.sent[0][0] } });
  h.tick(); assert.equal(h.sent.length, 1);
  await h.command('inbound accept'); h.tick(); assert.equal(h.sent.length, 2);
});

test('copied branch state does not enroll a fork under its new session identity', async t => {
  const h = await harness(t); await h.event('session_start');
  await h.call({ action: 'describe', description: 'old role' });
  await h.call({ action: 'join', swarm: 'old-team' });
  await h.event('session_shutdown');
  h.ctx.sessionManager.getSessionId = () => 'fork-id';
  await h.event('session_start');
  const status = (await h.call({ action: 'status' })).details;
  assert.deepEqual(status.self.swarms, []); assert.equal(status.self.description, '');
});

test('command message text preserves whitespace', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await h.command('send remote first  line\n  second line');
  assert.equal(peer.drain()[0].text, 'first  line\n  second line');
});

test('tool cancellation prevents messaging and membership changes', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  const signal = AbortSignal.abort();
  await assert.rejects(h.call({ action: 'send', target: 'remote', text: 'cancelled' }, signal), { name: 'AbortError' });
  await assert.rejects(h.call({ action: 'join', swarm: 'team' }, signal), { name: 'AbortError' });
  assert.deepEqual(peer.drain(), []); assert.deepEqual((await peer.list())[0].swarms, []);
});

test('session replacement does not inherit the previous session inbox or memberships', async t => {
  const h = await harness(t); await h.event('session_start'); const peer = await remote(t, h);
  await h.call({ action: 'join', swarm: 'team' }); await h.command('inbound hold'); await peer.send('local', 'old');
  await h.event('session_shutdown');
  h.ctx.sessionManager = { getSessionId: () => 'new-session', getBranch: () => [] };
  await h.event('session_start'); h.tick();
  const info = (await peer.list())[0]; assert.equal(info.sessionId, 'new-session'); assert.deepEqual(info.swarms, []);
  assert.equal(h.sent.length, 0);
});
