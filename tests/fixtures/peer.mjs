import { Peer } from '../../src/transport.js';
const peer = await Peer.start({ sessionId: 'child-session', name: 'child', description: 'process test', model: 'test/child', cwd: process.cwd(), swarms: [], state: 'idle' }, { directory: process.argv[2] });
process.send(peer.info);
process.on('message', async command => {
  if (command === 'drain') process.send(peer.drain());
  if (command === 'close') { await peer.close(); process.disconnect(); }
});
