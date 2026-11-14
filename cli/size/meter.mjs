// The rows-read meter of `rer size`: a Worker module that wraps every D1 binding the app reads, and the Node-side
// collector the wrapper reports to. It exists only inside a disposable verification install: serveHosted adds it
// when a caller passes `meter`, and no other caller changes.
//
// Local D1's own meta.rows_read and meta.rows_written are the numbers. D1's first() and raw() return no meta, so the
// wrapper runs them through all() and reshapes the result; a raw() read therefore sees each column name once.

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// The wrapper's runtime, as Worker source. It runs in workerd: no imports, no Node.
const runtime = String.raw`
const originals = new WeakMap();
const wrappers = new WeakMap();
const param = value => value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? { $blob: value.byteLength } : value;
const post = (service, event) => service.fetch('https://meter.invalid/', { method: 'POST', body: JSON.stringify(event) }).then(response => response.body?.cancel(), () => {});

async function measured(service, binding, sql, params, run) {
 let result;
 try { result = await run(); }
 catch (error) { await post(service, { kind: 'statement', binding, sql, params, rows_read: 0, rows_written: 0, error: String(error?.message ?? error) }); throw error; }
 await post(service, { kind: 'statement', binding, sql, params, rows_read: result?.meta?.rows_read ?? 0, rows_written: result?.meta?.rows_written ?? 0 });
 return result;
}

function wrapStatement(service, binding, statement, sql, params) {
 const run = work => measured(service, binding, sql, params, work);
 const wrapped = {
  bind: (...values) => wrapStatement(service, binding, statement.bind(...values), sql, values.map(param)),
  all: () => run(() => statement.all()),
  run: () => run(() => statement.run()),
  first: async column => {
   const row = (await run(() => statement.all())).results[0];
   if (column === undefined) return row ?? null;
   if (row && !(column in row)) throw new Error('D1_ERROR: No such column: ' + column);
   return row ? row[column] : null;
  },
  raw: async options => {
   const { results } = await run(() => statement.all());
   const rows = results.map(row => Object.values(row));
   return options?.columnNames ? [Object.keys(results[0] ?? {}), ...rows] : rows;
  },
 };
 originals.set(wrapped, { statement, sql, params });
 return wrapped;
}

function wrapDatabase(service, binding, db) {
 const wrapped = {
  prepare: sql => wrapStatement(service, binding, db.prepare(sql), sql, []),
  batch: async statements => {
   const parts = statements.map(statement => originals.get(statement) ?? { statement, sql: '[unknown statement]', params: [] });
   let results;
   try { results = await db.batch(parts.map(part => part.statement)); }
   catch (error) {
    for (const part of parts) await post(service, { kind: 'statement', binding, sql: part.sql, params: part.params, rows_read: 0, rows_written: 0, batch: true, error: String(error?.message ?? error) });
    throw error;
   }
   for (const [index, part] of parts.entries()) await post(service, { kind: 'statement', binding, sql: part.sql, params: part.params, rows_read: results[index]?.meta?.rows_read ?? 0, rows_written: results[index]?.meta?.rows_written ?? 0, batch: true });
   return results;
  },
 };
 if (typeof db.exec === 'function') wrapped.exec = async sql => {
  try { const result = await db.exec(sql); await post(service, { kind: 'statement', binding, sql, params: [], rows_read: 0, rows_written: 0, exec: true }); return result; }
  catch (error) { await post(service, { kind: 'statement', binding, sql, params: [], rows_read: 0, rows_written: 0, exec: true, error: String(error?.message ?? error) }); throw error; }
 };
 if (typeof db.dump === 'function') wrapped.dump = () => db.dump();
 if (typeof db.withSession === 'function') wrapped.withSession = constraint => wrapDatabase(service, binding, db.withSession(constraint));
 if (typeof db.getBookmark === 'function') wrapped.getBookmark = () => db.getBookmark();
 return wrapped;
}

// One wrapper per underlying binding, so an application that caches its database handle keeps one.
function meteredDatabase(env, binding) {
 const db = env[binding];
 if (!db) return db;
 if (!wrappers.has(db)) wrappers.set(db, wrapDatabase(env.RER_SIZE_METER, binding, db));
 return wrappers.get(db);
}

function wrapEnv(env) {
 const wrapped = { ...env };
 for (const binding of D1_BINDINGS) if (env[binding]) wrapped[binding] = meteredDatabase(env, binding);
 return wrapped;
}

// waitUntil work is announced to the collector, which closes a flow's window only once it has settled. The
// announcements are awaited before the handler answers, so none is still in flight when the response is read.
function wrapContext(env, ctx, announced) {
 return new Proxy(ctx, { get: (target, key) => {
  if (key === 'waitUntil') return promise => {
   const start = post(env.RER_SIZE_METER, { kind: 'wait', delta: 1 });
   announced.push(start);
   target.waitUntil(Promise.resolve(promise).finally(async () => { await start; await post(env.RER_SIZE_METER, { kind: 'wait', delta: -1 }); }));
  };
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
 } });
}

const handled = (name, handler) => async (first, env, ctx) => {
 const announced = [];
 try { return await handler.call(app, first, wrapEnv(env), wrapContext(env, ctx, announced)); }
 finally { await Promise.all(announced); }
};
`;

/**
 * The text of the wrapper module the Worker runs as its entry. It imports `inner` (the app, or the preparation
 * wrapper around it), re-exports everything, wraps the D1 bindings named in `d1` in the env of `fetch`, `scheduled`
 * and `queue`, and exports each Durable Object class in `durableObjects` as a subclass of the same name whose
 * constructor env is wrapped.
 */
export function meterModule({ inner, d1 = [], durableObjects = [] }) {
 const classes = durableObjects.filter(name => identifier.test(name));
 return [
  `import * as native from ${JSON.stringify(inner)};`,
  `export * from ${JSON.stringify(inner)};`,
  `const app = native.default;`,
  `const D1_BINDINGS = ${JSON.stringify(d1)};`,
  `if (!app || typeof app !== 'object') throw new Error('rer size meters a Worker whose default export is a handler object with fetch, scheduled and queue methods.');`,
  runtime,
  ...classes.map(name => `export class ${name} extends native.${name} { constructor(ctx, env) { super(ctx, wrapEnv(env)); } }`),
  `export default { ...app, ...(app.fetch ? { fetch: handled('fetch', app.fetch) } : {}), ...(app.scheduled ? { scheduled: handled('scheduled', app.scheduled) } : {}), ...(app.queue ? { queue: handled('queue', app.queue) } : {}) };`,
 ].join('\n');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The Node-side collector. `service` is the function the install's Miniflare gets as the RER_SIZE_METER service
 * binding. `open()` starts a flow's window; `close()` waits until the window's work has finished and returns what
 * ran in it: { statements: [{ binding, sql, params, rows_read, rows_written, error?, exec?, batch? }], unsettled }.
 * Work outside a window (the owner's sign-in, other personas) is not recorded.
 */
export function createMeter() {
 let current = null, pending = 0, lastEvent = 0, stopped = false;
 const service = async request => {
  const event = await request.json();
  if (stopped) return new Response(null, { status: 204 });
  lastEvent = performance.now();
  if (event.kind === 'wait') pending = Math.max(0, pending + event.delta);
  else if (current) current.statements.push({ binding: event.binding, sql: event.sql, params: event.params ?? [], rows_read: event.rows_read ?? 0, rows_written: event.rows_written ?? 0, ...(event.error ? { error: event.error } : {}), ...(event.exec ? { exec: true } : {}), ...(event.batch ? { batch: true } : {}) });
  return new Response(null, { status: 204 });
 };
 return {
  service,
  stop() { stopped = true; current = null; },
  /** Starts a window. The returned `close` ends it once the caller has read the response, its waitUntil work has
   * settled and no statement has been recorded for `quietMs`; after `maxMs` it ends regardless and says so. */
  open() {
   if (stopped) throw new Error('This measurement session has stopped.');
   if (current) throw new Error('A meter window is already open.');
   const window = current = { statements: [] };
   return {
    statements: window.statements,
    close: async ({ quietMs = 250, maxMs = 30_000 } = {}) => {
     const readAt = performance.now();
     let unsettled = false;
     while (true) {
      if (stopped) { unsettled = true; break; }
      const now = performance.now(), quiet = now - Math.max(lastEvent, readAt) >= quietMs;
      if (pending === 0 && quiet) break;
      if (now - readAt >= maxMs) { unsettled = true; break; }
      await sleep(Math.min(25, quietMs));
     }
     current = null;
     return { statements: window.statements, unsettled };
    },
   };
  },
 };
}
