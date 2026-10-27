// Nested tables and loops share their registration's failure collector. A failed
// leaf must not throw through its enclosing loop and suppress the remaining rows.
const failures = new WeakMap();

/** A table row owns the same cleanup and mock boundary as its former registration. */
export async function caseRow(t, name, run) {
  const cleanup = [];
  const errors = [];
  const pending = [];
  // Detached work must be handed off explicitly; observe it immediately so its
  // rejection remains local to this row rather than becoming unhandled.
  const defer = work => {
    pending.push(Promise.resolve(work).then(() => {}, error => { errors.push(error); }));
  };
  const drain = async () => {
    for (let index = 0; index < pending.length; index++) await pending[index];
    pending.length = 0;
  };
  const context = new Proxy(t, {
    get(target, key) {
      if (key === 'name') return name;
      if (key === 'defer') return defer;
      if (key === 'after') return (hook) => { cleanup.push(hook); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const collector = failures.get(t);
  if (collector) failures.set(context, collector);
  try {
    await run(context);
  } catch (error) {
    errors.push(error);
  } finally {
    await drain();
    for (const hook of cleanup) {
      try { await hook(); } catch (error) { errors.push(error); }
      await drain();
    }
    try { t.mock.timers.reset(); } catch (error) { errors.push(error); }
    try { t.mock.reset(); } catch (error) { errors.push(error); }
    failures.delete(context);
  }
  if (errors.length) {
    const failure = new AggregateError(errors, `${name}: ${errors.map(error => error?.message ?? String(error)).join("; ")}`);
    if (collector) collector.push(failure);
    else throw failure;
  }
}

/** Run every scenario even after a failure, retaining each original case name. */
export async function caseRows(t, rows) {
  const inherited = failures.get(t);
  const errors = inherited ?? [];
  if (rows.length === 0) {
    const error = new Error(`${t.name}: case table must contain at least one row`);
    if (inherited) { inherited.push(error); return; }
    throw error;
  }
  const context = new Proxy(t, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  failures.set(context, errors);
  try {
    for (const [name, run] of rows) {
      // Keep siblings running even if row setup or teardown itself fails.
      try { await caseRow(context, name, run); }
      catch (error) { errors.push(new AggregateError([error], `${name}: ${error?.message ?? String(error)}`)); }
    }
  } finally {
    failures.delete(context);
  }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
}
