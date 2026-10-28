// Keep the caseRow/caseRows API shared with import-kit's folded journeys.
// Nested tables inherit the registration collector so failed leaves never abort siblings.
const failures = new WeakMap();

/**
 * Each row owns its cleanup hooks and mock lifetime, as its former test did.
 * Return/await async work, or hand it to row.defer(promise) before the row ends.
 * Unregistered work cannot be collected without process-wide rejection hooks.
 */
export async function caseRow(t, name, run) {
  const cleanup = [];
  const errors = [];
  const pending = [];
  // Observe handed-off work immediately, before a rejection can escape the row.
  const defer = work => {
    pending.push(Promise.resolve(work).then(() => {}, error => { errors.push(error); }));
  };
  const drain = async () => {
    // Work may hand off more work before settling.
    for (let index = 0; index < pending.length; index++) await pending[index];
    pending.length = 0;
  };
  const context = new Proxy(t, { get(target, key) {
    if (key === 'name') return name;
    if (key === 'defer') return defer;
    if (key === 'after') return hook => { cleanup.push(() => hook(context)); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const collector = failures.get(t);
  if (collector) failures.set(context, collector);
  try { await run(context); }
  catch (error) { errors.push(error); }
  finally {
    await drain();
    for (const hook of cleanup) {
      try { await hook(); } catch (error) { errors.push(error); }
      await drain();
    }
    // Restore method spies before timers: a spy may have captured a fake timer.
    try { t.mock.reset(); } catch (error) { errors.push(error); }
    try { t.mock.timers.reset(); } catch (error) { errors.push(error); }
    failures.delete(context);
  }
  if (errors.length) {
    const failure = new AggregateError(errors, name);
    if (collector) collector.push(failure);
    else throw failure;
  }
}

/** Run every row, then fail the single registration with all failed row names. */
export async function caseRows(t, rows) {
  const inherited = failures.get(t);
  const errors = inherited ?? [];
  if (rows.length === 0) {
    const error = new Error(`${t.name}: case table must contain at least one row`);
    if (inherited) { inherited.push(error); return; }
    throw error;
  }
  const context = new Proxy(t, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  failures.set(context, errors);
  try {
    for (const [name, run] of rows) await caseRow(context, name, run);
  } finally { failures.delete(context); }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
}
