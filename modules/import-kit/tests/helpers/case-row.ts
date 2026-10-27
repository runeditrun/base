import type { TestContext } from 'node:test';

export type CaseRowContext = TestContext & {
  /** Hand off work that the row starts without returning or awaiting it. */
  defer(work: PromiseLike<unknown>): void;
};

export type CaseRow = [name: string, run: (context: CaseRowContext) => unknown];

// Nested tables and loops share their registration's failure collector. A failed
// leaf must not throw through its enclosing loop and suppress the remaining rows.
const failures = new WeakMap<TestContext, unknown[]>();

/** A table row owns the same cleanup and mock boundary as its former registration. */
export async function caseRow(t: TestContext, name: string, run: CaseRow[1]): Promise<void> {
  const cleanup: Array<() => unknown> = [];
  const errors: unknown[] = [];
  const pending: Promise<void>[] = [];
  const defer = (work: PromiseLike<unknown>): void => {
    // Observe immediately, even while the row is still running. Each observer
    // fulfills so a rejection cannot escape before we drain the row's work.
    pending.push(Promise.resolve(work).then(() => {}, error => { errors.push(error); }));
  };
  const drain = async (): Promise<void> => {
    // Deferred work may hand off more work before it settles.
    for (let index = 0; index < pending.length; index++) await pending[index];
    pending.length = 0;
  };
  const context = new Proxy(t, {
    get(target, key) {
      if (key === 'name') return name;
      if (key === 'defer') return defer;
      if (key === 'after') return (hook: () => unknown) => { cleanup.push(hook); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as CaseRowContext;
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
    const failure = new AggregateError(errors, name);
    if (collector) collector.push(failure);
    else throw failure;
  }
}

/** Run every scenario even after a failure, retaining each original case name. */
export async function caseRows(t: TestContext, rows: CaseRow[]): Promise<void> {
  const inherited = failures.get(t);
  const errors: unknown[] = inherited ?? [];
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
      await caseRow(context, name, run);
    }
  } finally {
    failures.delete(context);
  }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => (error as Error).message).join('\n'));
  }
}
