// Fake only the Container platform. Its process state survives a Durable Object
// restart; a per-object inactivity timeout must be installed again on recovery.
export function platform(ctx, app, failures = 0) {
  const id = ctx.id.toString(), sql = ctx.storage.sql;
  const read = () => {
    sql.exec('CREATE TABLE IF NOT EXISTS _test_container_platform(id INTEGER PRIMARY KEY, value TEXT)');
    const row = [...sql.exec('SELECT value FROM _test_container_platform WHERE id=1')][0];
    return row ? JSON.parse(row.value) : { running: false };
  };
  const write = patch => {
    const value = { ...read(), ...patch };
    sql.exec('INSERT OR REPLACE INTO _test_container_platform VALUES(1, ?)', JSON.stringify(value));
    return value;
  };
  const now = () => read().time ?? Date.now();
  const tell = (what, body) => app.fetch(`http://platform/${what}`, { method: 'POST', headers: { 'x-demo': id }, body: JSON.stringify(body) });
  const expire = () => {
    const state = read();
    if (state.running && state.inactiveAt != null && now() - state.inactiveAt >= (state.timeout ?? 120_000)) {
      write({ running: false }); void tell('stopped', {});
    }
  };
  // Observe the previous object's grace period, then model the new object's
  // default timeout. The real platform also requires it to be reconfigured.
  expire(); write({ timeout: null, inactiveAt: null });
  let exit;
  let stopped = new Promise((_, reject) => { exit = reject; });
  return {
    now,
    get running() { expire(); return read().running; },
    active() { expire(); write({ inactiveAt: null }); },
    inactive() { write({ inactiveAt: now() }); },
    advance(ms) { const time = now(); write({ inactiveAt: read().inactiveAt ?? time, time: time + ms }); },
    start(options) {
      stopped = new Promise((_, reject) => { exit = reject; });
      write({ running: true });
      if (failures-- > 0) {
        write({ running: false });
        queueMicrotask(() => exit(new Error('There is no container instance that can be provided to this Durable Object, try again later')));
      } else void tell('start', options);
    },
    async setInactivityTimeout(timeout) { write({ timeout }); },
    monitor: () => stopped,
    async destroy() {
      const response = await tell('destroy', {});
      if (!response.ok) throw new Error('SECRET destroy');
      write({ running: false });
    },
    getTcpPort: () => ({ async fetch(input, init) {
      const request = new Request(input, init);
      if (new URL(request.url).protocol !== 'http:') throw new TypeError('Connecting to a container using HTTPS is not currently supported');
      expire();
      if (!read().running) throw new TypeError('SECRET the container is not running');
      request.headers.set('x-demo', id);
      const response = await app.fetch(request);
      if (response.status === 599) {
        write({ running: false }); exit(Object.assign(new Error('SECRET exit'), { exitCode: 7 }));
        throw new TypeError('SECRET transport');
      }
      if (response.status === 598) { write({ running: false }); throw new TypeError('SECRET the container is not running'); }
      return response;
    } }),
  };
}
