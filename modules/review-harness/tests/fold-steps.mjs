// Returned work is awaited. Nested tables/steps are tracked automatically;
// other detached work must be handed to row.defer() before the row settles.
// No process-wide rejection listener is installed.
/** @typedef {import('node:test').TestContext & { defer(work: PromiseLike<unknown>): void }} RowContext */

/**
 * Run named input rows without registering more tests. Each row retains its
 * own cleanup scope, so temporary stores and processes close before the next.
 * @param {import('node:test').TestContext} test
 */
function isolatedStep(test) {
  /**
   * @param {string} name
   * @param {((context: RowContext) => unknown) | {timeout: number}} options
   * @param {(context: RowContext) => unknown} [callback]
   */
  return async function step(name, options, callback) {
    const run = typeof options === 'function' ? options : callback;
    const timeout = typeof options === 'function' ? undefined : options.timeout;
    if (!run) throw new TypeError('A named step requires a callback');
    const cleanups = [], errors = [], deferred = [];
    // Observe handed-off work immediately; drain again when it starts more work.
    const defer = work => {
      deferred.push(Promise.resolve(work).then(() => {}, error => { errors.push(error); }));
    };
    const drain = async () => {
      for (let index = 0; index < deferred.length; index++) await deferred[index];
      deferred.length = 0;
    };
    const controller = new AbortController();
    const abort = () => controller.abort(test.signal.reason);
    test.signal.addEventListener('abort', abort, { once: true });
    if (test.signal.aborted) abort();
    const context = new Proxy(test, {
      get(target, key) {
        if (key === 'defer') return defer;
        if (key === 'after') return callback => { cleanups.push(callback); };
        if (key === 'signal') return controller.signal;
        if (key === 'name') return name;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const collector = failures.get(test);
    if (collector) failures.set(context, collector);
    let timer;
    try {
      const pending = (async () => {
        try { await run(context); } catch (error) { errors.push(error); }
        await drain();
      })();
      await (timeout === undefined ? pending : Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Step exceeded its original timeout');
          controller.abort(error); reject(error);
        }, timeout);
      })]));
    } catch (error) { errors.push(error); }
    finally {
      clearTimeout(timer);
      controller.abort();
      test.signal.removeEventListener('abort', abort);
      for (const cleanup of cleanups) {
        try { await cleanup(context); } catch (error) { errors.push(error); }
        await drain();
      }
      failures.delete(context);
    }
    if (errors.length) {
      const error = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Step and cleanup failed');
      if (error instanceof Error) error.message = name + ': ' + error.message;
      throw error;
    }
  };
}

// A nested family shares its registration's collector so a failed leaf cannot
// abort its enclosing table. Each leaf still owns its cleanup and timeout.
const failures = new WeakMap();

/** @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {(context: RowContext) => unknown} run */
export function caseRow(t, name, run) {
  const pending = collectRow(t, name, run);
  if (typeof t.defer === 'function') t.defer(pending);
  return pending;
}

/** @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {(context: RowContext) => unknown} run */
async function collectRow(t, name, run) {
  try {
    await isolatedStep(t)(name, run);
  } catch (error) {
    const collector = failures.get(t);
    if (!collector) throw error;
    collector.push(error);
  }
}

/** @param {import('node:test').TestContext} t
 * @param {Array<[string, (context: RowContext) => unknown]>} rows */
export function caseRows(t, rows) {
  const pending = collectRows(t, rows);
  if (typeof t.defer === 'function') t.defer(pending);
  return pending;
}

/** @param {import('node:test').TestContext} t
 * @param {Array<[string, (context: RowContext) => unknown]>} rows */
async function collectRows(t, rows) {
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
    for (const [name, run] of rows) await caseRow(context, name, run);
  } finally { failures.delete(context); }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
}

/** @param {import('node:test').TestContext} test */
export function namedSteps(test) {
  const run = isolatedStep(test);
  return (name, options, callback) => {
    const pending = (async () => {
      try {
        const body = typeof options === 'function' ? options : callback;
        await (typeof options === 'function' ? run(name, body) : run(name, options, body));
      } catch (error) {
        const collector = failures.get(test);
        if (!collector) throw error;
        collector.push(error);
      }
    })();
    // A nested named step belongs to its parent even if the caller omits await.
    if (typeof test.defer === 'function') test.defer(pending);
    return pending;
  };
}
