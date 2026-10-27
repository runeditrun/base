import type { TestContext } from 'node:test';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';

type RowScope = { errors: unknown[]; active: boolean };
const currentRow = new AsyncLocalStorage<RowScope>();
const promiseRows = new WeakMap<object, RowScope>();
const promiseHook = createHook({
  init(_id, type, _trigger, resource: object) {
    const row = currentRow.getStore();
    if (type === 'PROMISE' && row) promiseRows.set(resource, row);
  },
});
let activeRows = 0;
let previousListeners: ReturnType<typeof process.rawListeners> = [];
const rejection = (error: unknown, promise: Promise<unknown>): void => {
  const row = promiseRows.get(promise);
  if (row?.active) row.errors.push(error);
  // Preserve the test runner's handling for unrelated or late failures.
  else for (const listener of previousListeners) listener.call(process, error, promise);
};
function observeRejections(): () => void {
  if (activeRows++ === 0) {
    previousListeners = process.rawListeners('unhandledRejection');
    for (const listener of previousListeners) process.removeListener('unhandledRejection', listener);
    process.on('unhandledRejection', rejection);
    promiseHook.enable();
  }
  return () => {
    if (--activeRows === 0) {
      promiseHook.disable();
      process.removeListener('unhandledRejection', rejection);
      for (const listener of previousListeners) process.on('unhandledRejection', listener);
      previousListeners = [];
    }
  };
}

export type CaseRowContext = TestContext & {
  /** Hand off work that the row starts without returning or awaiting it. */
  defer(work: PromiseLike<unknown>): void;
};

export type CaseRow = [name: string, run: (context: CaseRowContext) => unknown];

// Nested tables and loops share their registration's failure collector. A failed
// leaf must not throw through its enclosing loop and suppress the remaining rows.
const failures = new WeakMap<TestContext, unknown[]>();

/** A table row owns the same cleanup and mock boundary as its former registration. */
export function caseRow(t: TestContext, name: string, run: CaseRow[1]): Promise<void> {
  const pending = collectRow(t, name, run);
  // Nested runner work belongs to its parent even when the caller omits await.
  if (typeof (t as CaseRowContext).defer === 'function') (t as CaseRowContext).defer(pending);
  return pending;
}

async function collectRow(t: TestContext, name: string, run: CaseRow[1]): Promise<void> {
  const cleanup: Array<() => unknown> = [];
  const errors: unknown[] = [];
  const pending: Promise<void>[] = [];
  const scope: RowScope = { errors, active: true };
  const stopObserving = observeRejections();
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
    await currentRow.run(scope, () => run(context));
  } catch (error) {
    errors.push(error);
  } finally {
    await drain();
    for (const hook of cleanup) {
      try { await currentRow.run(scope, hook); } catch (error) { errors.push(error); }
      await drain();
    }
    try { t.mock.timers.reset(); } catch (error) { errors.push(error); }
    try { t.mock.reset(); } catch (error) { errors.push(error); }
    // Two check-phase turns include detached microtasks and work scheduled with
    // setImmediate by the row. No wall-clock delay or longer test timeout.
    // Later rejections remain the test runner's responsibility; use defer for
    // work that must be drained beyond this bounded observation window.
    try {
      await nextTurn();
      await nextTurn();
      await Promise.resolve();
      await drain();
    } finally {
      scope.active = false;
      stopObserving();
      failures.delete(context);
    }
  }
  if (errors.length) {
    const failure = new AggregateError(errors, name);
    if (collector) collector.push(failure);
    else throw failure;
  }
}

/** Run every scenario even after a failure, retaining each original case name. */
export function caseRows(t: TestContext, rows: CaseRow[]): Promise<void> {
  const pending = collectRows(t, rows);
  if (typeof (t as CaseRowContext).defer === 'function') (t as CaseRowContext).defer(pending);
  return pending;
}

async function collectRows(t: TestContext, rows: CaseRow[]): Promise<void> {
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
    throw new AggregateError(errors, `${t.name}: ${errors.map(error => (error as Error).message).join('\n')}`);
  }
}
