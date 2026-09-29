import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Peer } from '../src/transport.js';
import { verifyInstalledQueue } from './queue-smoke.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pt-'));
const child = spawn(process.env.PI_BIN || 'pi', ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--extension', resolve('extensions/pi-talk.js'), '--mode', 'rpc', '--no-session', '--name', 'talk-smoke', '--talk-dir', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '', buffer = '';
const records = [];
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (line.trim()) records.push(JSON.parse(line));
  }
});
const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
const exited = once(child, 'exit');
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    const result = predicate(); if (result) return result;
    if (child.exitCode !== null || child.signalCode) throw new Error(`Pi exited: ${stderr}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Pi smoke timed out: ${stderr}\n${JSON.stringify(records)}`);
}
async function request(command) {
  const id = String(records.length);
  child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  const response = await waitFor(() => records.find(record => record.type === 'response' && record.id === id));
  assert.equal(response.success, true, JSON.stringify(response));
  return response;
}
let probe;
try {
  await request({ type: 'get_state' });
  probe = await Peer.start({ sessionId: 'probe', name: 'probe', description: '', model: 'test/probe', cwd: process.cwd(), swarms: [], state: 'idle' }, { directory });
  const peers = await probe.list();
  assert.equal(peers.length, 1, stderr); assert.equal(peers[0].name, 'talk-smoke');
  await request({ type: 'prompt', message: '/talk inbound hold' });
  assert.equal((await probe.send(peers[0].instanceId, 'held without a model call')).status, 'held');
  await request({ type: 'prompt', message: '/talk describe Smoke specialist' });
  assert.equal((await probe.list())[0].description, 'Smoke specialist');
  child.stdin.end();
  const [code] = await exited; assert.equal(code, 0, stderr);
  assert.deepEqual(await probe.list(), []);
  await probe.close(); probe = undefined;
  assert.deepEqual(await readdir(directory), []);
  await verifyInstalledQueue(directory);
  assert.deepEqual(await readdir(directory), []);
  console.log('Pi runtime smoke passed: package load, registry, commands, hold, metadata, shutdown cleanup, and bounded custom steering using installed Pi queue methods. No model calls.');
} finally {
  clearTimeout(deadline); if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  await probe?.close(); await rm(directory, { recursive: true, force: true });
}
