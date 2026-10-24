import { liveServers } from '../../../registry.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Registry entries belong to this fixture's isolated directory. Record their
// PIDs before signalling; never sweep another checkout or use a global stop.
export async function stopOwnedApp(env, checkout) {
 const records = (await liveServers(env)).filter(record => record.checkout === checkout);
 for (const record of records) {
  try { process.kill(record.owner.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
 }
 const deadline = Date.now() + 15000;
 while ((await liveServers(env)).some(record => records.some(saved => saved.owner.pid === record.owner.pid))) {
  if (Date.now() >= deadline) throw new Error('Owned fixture app did not stop');
  await delay(100);
 }
}
