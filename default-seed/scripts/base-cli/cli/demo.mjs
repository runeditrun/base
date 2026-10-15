import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { refuse } from './errors.mjs';
import { shared } from './shared.mjs';

// `rer demo` (dev --demo) state and its two adoption checks (export/DEMO.md).
const adopt = 'See DEMO.md: a seed adopts demo mode with src/demo.ts, withDemo as the first import of its Worker entry, and three vite.config changes.';

// Before anything starts: the seed's Vite persists where rer says, so the
// checkout's own .wrangler/state is never opened by a demo, and hands the
// Worker's cloudflare:sockets imports demo mode's guarded connect.
export async function demoAdopted(root) {
 let text = '';
 for (const name of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
  try { text = await readFile(join(root, name), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 if (!text.includes('RER_STATE_DIR')) throw refuse(`This seed's vite.config does not persist to RER_STATE_DIR, so a demo would run on this checkout's own data. ${adopt}`);
 if (!text.includes('demoSockets(')) throw refuse(`This seed's vite.config does not list demoSockets(), so direct mail transports would not pass through the demo effect guard. ${adopt}`);
}

// A demo's data lives in .rer/demo/START. Only one server runs per checkout, so
// any other demo folder is a stopped demo's leftover (a hard kill) and goes now.
// The end is local ISO time with its offset, also returned in readiness metadata.
export async function demoState(root, seconds) {
 const { privateDirectory } = await shared('private-files.mjs');
 const started = new Date(), stamp = started.toISOString().replace(/[-:]|\.\d+/g, '');
 const parent = await privateDirectory(root, ['.rer', 'demo']);
 for (const entry of await readdir(parent)) await rm(join(parent, entry), { recursive: true, force: true });
 const end = new Date(started.getTime() + seconds * 1000), offset = -end.getTimezoneOffset();
 const local = new Date(end.getTime() + offset * 60000).toISOString().slice(0, 19);
 const zone = `${offset < 0 ? '-' : '+'}${String(Math.trunc(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
 return { state: await privateDirectory(root, ['.rer', 'demo', stamp]), ends: local + zone };
}

// After start: a request has passed withDemo, which creates rer_demo in the
// demo's own database. Without it effect simulation is unproved, so the demo stops.
export async function demoGuarded(url, state, signal) {
 const { appFetch } = await shared('app-fetch.mjs');
 await (await appFetch(url + '/health', { signal })).body?.cancel();
 const directory = join(state, 'v3/d1/miniflare-D1DatabaseObject');
 for (const file of (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite')) {
  const db = new DatabaseSync(join(directory, file), { readOnly: true });
  try { if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rer_demo'").get()) return; } finally { db.close(); }
 }
 throw refuse(`The app did not start in demo mode (no withDemo guard answered), so external writes might run for real. The demo was stopped and its data deleted. ${adopt}`);
}
