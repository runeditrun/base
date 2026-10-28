/**
 * Run named input rows without registering more tests. Each row retains its
 * own cleanup scope, so temporary stores and processes close before the next.
 * @param {import('node:test').TestContext} test
 */
function isolatedStep(test) {
  /**
   * @param {string} name
   * @param {((context: import('node:test').TestContext) => unknown) | {timeout: number}} options
   * @param {(context: import('node:test').TestContext) => unknown} [callback]
   */
  return async function step(name, options, callback) {
    const run = typeof options === 'function' ? options : callback;
    const timeout = typeof options === 'function' ? undefined : options.timeout;
    if (!run) throw new TypeError('A named step requires a callback');
    const cleanups = [], errors = [];
    const controller = new AbortController();
    const abort = () => controller.abort(test.signal.reason);
    test.signal.addEventListener('abort', abort, { once: true });
    if (test.signal.aborted) abort();
    const context = new Proxy(test, {
      get(target, key) {
        if (key === 'after') return callback => { cleanups.push(callback); };
        if (key === 'signal') return controller.signal;
        if (key === 'name') return name;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let timer;
    try {
      const pending = Promise.resolve().then(() => run(context));
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
      }
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
 * @param {(context: import('node:test').TestContext) => unknown} run */
export async function caseRow(t, name, run) {
  try {
    await isolatedStep(t)(name, run);
  } catch (error) {
    const collector = failures.get(t);
    if (!collector) throw error;
    collector.push(error);
  }
}

/** @param {import('node:test').TestContext} t
 * @param {Array<[string, (context: import('node:test').TestContext) => unknown]>} rows */
export async function caseRows(t, rows) {
  const inherited = failures.get(t);
  const errors = inherited ?? [];
  const context = new Proxy(t, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  failures.set(context, errors);
  try {
    for (const [name, run] of rows) await caseRow(context, name, async row => {
      failures.set(row, errors);
      try { await run(row); } finally { failures.delete(row); }
    });
  } finally { failures.delete(context); }
  if (!inherited && errors.length) {
    throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
}

/** @param {import('node:test').TestContext} test */
export function namedSteps(test) {
  const run = isolatedStep(test);
  return async (name, options, callback) => {
    try {
      const body = typeof options === 'function' ? options : callback;
      const scoped = async context => {
        const collector = failures.get(test);
        if (collector) failures.set(context, collector);
        try { await body(context); } finally { failures.delete(context); }
      };
      await (typeof options === 'function' ? run(name, scoped) : run(name, options, scoped));
    } catch (error) {
      const collector = failures.get(test);
      if (!collector) throw error;
      collector.push(error);
    }
  };
}
