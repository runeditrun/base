import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A built seed for the growth check's tests: a Worker with one D1 binding and one Durable Object class, a
// cron, an owner-claim route and the routes below. Each route reads `items` in a way the check should judge.
//   /scan /raw /batch /session-scan   an unindexed scan through first(), raw(), batch() and a D1 session
//   /keyed                            one primary-key read
//   /heavy                            600 rows at every size: over a low ceiling, not growth
//   /deep                             13 nested EXISTS, which local D1 refuses
//   /later                            answers at once and scans in ctx.waitUntil
//   /counter, /ws                     a Durable Object that scans, and its WebSocket that sends one message
//   /signin, /me/<token>              a token and a cookie, then a route that needs both
//   scheduled                         one scan
const migration = `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
CREATE TABLE items (id TEXT PRIMARY KEY, note TEXT NOT NULL);
CREATE TABLE filler (id INTEGER PRIMARY KEY);
CREATE TABLE queue_effects (id INTEGER PRIMARY KEY);
`;
const scan = 'SELECT count(*) AS c FROM items WHERE note = ?';
const worker = `
const scan = ${JSON.stringify(scan)};
const deep = 'SELECT ' + 'EXISTS (SELECT 1 WHERE '.repeat(13) + '1' + ')'.repeat(13) + ' AS d';
export class Counter {
 constructor(state, env) { this.env = env; }
 async fetch(request) {
  const row = await this.env.DB.prepare(scan).bind('d').first();
  if (request.headers.get('upgrade') !== 'websocket') return Response.json(row);
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify(row));
  return new Response(null, { status: 101, webSocket: client });
 }
}
export default {
 async fetch(request, env, ctx) {
  const url = new URL(request.url), db = env.DB;
  if (url.pathname === '/auth/bootstrap' && request.method === 'POST') {
   const body = await request.json().catch(() => ({}));
   if (!env.SETUP_TOKEN || body.token !== env.SETUP_TOKEN) return new Response('forbidden', { status: 403 });
   await db.prepare('INSERT INTO users(id, email) VALUES(?, ?)').bind('owner', env.OWNER_EMAIL).run();
   await env.JOBS.send({ source: 'owner' });
   return new Response(null, { status: 303, headers: { location: body.returnTo ?? '/', 'set-cookie': 'session=owner; Path=/; HttpOnly' } });
  }
  switch (url.pathname) {
   case '/queue-state': return new Response(null, { status: (await db.prepare('SELECT count(*) AS c FROM queue_effects').first('c')) === 0 ? 200 : 409 });
   // Cross the real HTTP deadline without burning CPU; real D1 statements bracket the pending request.
   case '/slow':
    await db.prepare('SELECT id FROM filler WHERE id = ?').bind(1).all();
    await new Promise(resolve => setTimeout(resolve, 31000));
    return Response.json(await db.prepare('SELECT id FROM filler WHERE id > ?').bind(0).all());
   case '/after-slow':
    await new Promise(resolve => setTimeout(resolve, 2000));
    return Response.json(await db.prepare('SELECT id FROM items WHERE id = ?').bind('i0001').first());
   case '/scan': return Response.json(await db.prepare(scan).bind('x').first());
   case '/raw': return Response.json(await db.prepare(scan).bind('x').raw());
   case '/batch': return Response.json((await db.batch([db.prepare(scan).bind('x'), db.prepare('SELECT 1 AS one')])).map(result => result.results));
   case '/session-scan': return Response.json((await db.withSession().prepare(scan).bind('x').all()).results);
   case '/keyed': return Response.json(await db.prepare('SELECT id FROM items WHERE id = ?').bind('i0001').first());
   case '/heavy': return Response.json({ n: (await db.prepare('SELECT id FROM filler').all()).results.length });
   case '/deep': return Response.json((await db.prepare(deep).all()).results);
   case '/later': ctx.waitUntil(db.prepare(scan).bind('w').all()); return new Response('queued', { status: 202 });
   case '/counter': case '/ws': return env.COUNTER.get(env.COUNTER.idFromName('a')).fetch(request);
   case '/signin': return Response.json({ token: 'tok-7' }, { headers: { 'set-cookie': 'sid=s7; Path=/' } });
   case '/me/tok-7': return request.headers.get('cookie')?.includes('sid=s7') && request.headers.get('x-api') === 'k' ? new Response('hello') : new Response('no', { status: 401 });
   default: return new Response('not found', { status: 404 });
  }
 },
 async scheduled(controller, env) { await env.JOBS.send({ source: 'scheduled' }); await env.DB.prepare(scan).bind('s').all(); },
 async queue(batch, env) { await env.DB.prepare('SELECT id FROM filler WHERE id > ?').bind(0).all(); await env.DB.prepare('INSERT INTO queue_effects DEFAULT VALUES').run(); },
};
`;

/** The declaration the tests start from. */
export const declaration = {
 schema: 1, database: 'DB', budget: { windowRows: 100000, timeoutSeconds: 180 },
 personas: { owner: { kind: 'owner' }, anonymous: { kind: 'anonymous' }, visitor: {
  kind: 'signin', requests: [{ method: 'POST', path: '/signin', capture: { token: '/token' } }], headers: { 'X-Api': 'k' } } },
 shape: { tables: [
  { table: 'items', rows: { small: 50, large: 2000 }, values: { id: "printf('i%04d', n)", note: "printf('note %d', n)" } },
  { table: 'filler', rows: 600, values: { id: 'n' } },
 ] },
 flows: [
  { name: 'scan', persona: 'anonymous', request: { method: 'GET', path: '/scan' }, ceiling: 100000 },
  { name: 'raw-scan', persona: 'anonymous', request: { method: 'GET', path: '/raw' }, ceiling: 100000 },
  { name: 'batch-scan', persona: 'anonymous', request: { method: 'GET', path: '/batch' }, ceiling: 100000 },
  { name: 'session-scan', persona: 'anonymous', request: { method: 'GET', path: '/session-scan' }, ceiling: 100000 },
  { name: 'keyed', persona: 'owner', request: { method: 'GET', path: '/keyed' }, ceiling: 100 },
  { name: 'heavy', persona: 'anonymous', request: { method: 'GET', path: '/heavy' }, ceiling: 100 },
  { name: 'deep', persona: 'anonymous', request: { method: 'GET', path: '/deep' }, ceiling: 100000 },
  { name: 'later', persona: 'anonymous', request: { method: 'GET', path: '/later' }, ceiling: 100000 },
  { name: 'counter', persona: 'anonymous', request: { method: 'GET', path: '/counter' }, ceiling: 100000 },
  { name: 'socket', persona: 'anonymous', request: { method: 'GET', path: '/ws', websocket: true }, ceiling: 100000 },
  { name: 'me', persona: 'visitor', request: { method: 'GET', path: '/me/{{visitor.token}}' }, ceiling: 100 },
  { name: 'tick', scheduled: '* * * * *', ceiling: 100000 },
 ],
};

/** Writes the seed into `root` (an existing, empty folder) with `shape` as its size-check.json. */
export async function writeSizeSeed(root, shape = declaration, { base = resolve(import.meta.dirname, '../..') } = {}) {
 await mkdir(join(root, 'dist/server/migrations'), { recursive: true });
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'));
 const files = {
  'package.json': '{"type":"module"}', 'deploy.json': '{"version":1,"vars":{}}',
  'wrangler.jsonc': JSON.stringify({ triggers: { crons: ['* * * * *'] } }),
  'rer-setup.json': JSON.stringify({ fields: [], steps: [{ type: 'owner-claim', mode: 'setup-token', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }] }),
  'dist/server/wrangler.json': JSON.stringify({ main: 'index.js', compatibility_date: '2026-09-08', triggers: { crons: ['* * * * *'] },
   queues: { producers: [{ binding: 'JOBS', queue: 'size-jobs' }], consumers: [{ queue: 'size-jobs', max_batch_size: 1, max_batch_timeout: 0 }] },
   d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'app', migrations_dir: 'migrations' }],
   durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] } }),
  'dist/server/index.js': worker, 'dist/server/migrations/0001.sql': migration, 'size-check.json': JSON.stringify(shape),
 };
 for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
 return await realpath(root);
}
