import type { TestContext } from 'node:test';

export type CaseRow = [name: string, run: (context: TestContext) => unknown];

// Nested tables and loops share their registration's failure collector. A failed
// leaf must not throw through its enclosing loop and suppress the remaining rows.
const failures = new WeakMap<TestContext, unknown[]>();

/** A table row owns the same cleanup and mock boundary as its former registration. */
export async function caseRow(t: TestContext, name: string, run: CaseRow[1]): Promise<void> {
  const cleanup: Array<() => unknown> = [];
  const context = new Proxy(t, {
    get(target, key) {
      if (key === 'name') return name;
      if (key === 'after') return (hook: () => unknown) => { cleanup.push(hook); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const collector = failures.get(t);
  if (collector) failures.set(context, collector);
  const errors: unknown[] = [];
  try {
    await run(context);
  } catch (error) {
    errors.push(error);
  } finally {
    for (const hook of cleanup) {
      try { await hook(); } catch (error) { errors.push(error); }
    }
    try { t.mock.timers.reset(); } catch (error) { errors.push(error); }
    try { t.mock.reset(); } catch (error) { errors.push(error); }
    failures.delete(context);
  }
  if (errors.length) {
    const failure = new AggregateError(errors, name);
    if (collector) collector.push(failure);
    else throw failure;
  }
}

/** Run every scenario even after a failure, retaining each original case name. */
export async function caseRows(t: TestContext, rows: CaseRow[]): Promise<void> {
  const inherited = failures.get(t);
  const errors: unknown[] = inherited ?? [];
  const context = new Proxy(t, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  failures.set(context, errors);
  try {
    for (const [name, run] of rows) {
      await caseRow(context, name, run);
    }
  } finally {
    failures.delete(context);
  }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => (error as Error).message).join('\n'));
  }
}
