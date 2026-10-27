// Proven runner copied byte-identically from runeditrun/base commit
// db43e31e48e6796354479019fade1390aad1ec46, modules/import-kit/tests/helpers/case-row.ts.
// Returned work and unawaited nested runner calls are drained automatically.
// Detached rejections are observed through two event-loop turns and microtasks;
// later or unrelated failures retain the test runner's handling. Arbitrary
// fulfilled orphan promises cannot be detected. Use row.defer() beyond that window.
import { caseRow as runRow, caseRows as runRows } from './case-row.ts';

// Signal proxies must retain the copied runner's context identity in nested calls.
const owners = new WeakMap();

/** @param {import('node:test').TestContext} test
 * @param {import('./case-row.ts').CaseRow[]} rows */
export function caseRows(test, rows) {
  return runRows(owners.get(test) ?? test, rows);
}

/** @typedef {import('./case-row.ts').CaseRowContext} RowContext */

/** @param {import('node:test').TestContext} test
 * @param {string} name
 * @param {(context: RowContext) => unknown} run */
export function caseRow(test, name, run) {
  return runRow(owners.get(test) ?? test, name, run);
}

/**
 * Preserve the lease's original per-step abort signal and timeout interface.
 * Row ownership, cleanup, deferred work and failure collection use the copied runner.
 * @param {import('node:test').TestContext} test
 */
export function namedSteps(test) {
  /**
   * @param {string} name
   * @param {((context: RowContext) => unknown) | {timeout: number}} options
   * @param {(context: RowContext) => unknown} [callback]
   */
  return (name, options, callback) => {
    const run = typeof options === 'function' ? options : callback;
    const timeout = typeof options === 'function' ? undefined : options.timeout;
    if (!run) throw new TypeError('A named step requires a callback');
    return runRow(owners.get(test) ?? test, name, async row => {
      const controller = new AbortController();
      const abort = () => controller.abort(test.signal.reason);
      test.signal.addEventListener('abort', abort, { once: true });
      if (test.signal.aborted) abort();
      const context = new Proxy(row, {
        get(target, key) {
          if (key === 'signal') return controller.signal;
          if (key === 'after') return hook => row.after(() => hook(context));
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      owners.set(context, row);
      let timer;
      row.after(() => {
        clearTimeout(timer);
        controller.abort();
        test.signal.removeEventListener('abort', abort);
      });
      try {
        const pending = Promise.resolve().then(() => run(context));
        await (timeout === undefined ? pending : Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Step exceeded its original timeout');
            controller.abort(error);
            reject(error);
          }, timeout);
        })]));
      } finally {
        clearTimeout(timer);
      }
    }).catch(error => {
      // Keep the existing standalone named-step diagnostic interface.
      if (error instanceof AggregateError) {
        error.message = name + ': ' + error.errors.map(value => value instanceof Error ? value.message : String(value)).join('\n');
      }
      throw error;
    });
  };
}
