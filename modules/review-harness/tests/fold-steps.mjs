/**
 * Run named input rows without registering more tests. Each row retains its
 * own cleanup scope, so temporary stores and processes close before the next.
 * @param {import('node:test').TestContext} test
 */
export function namedSteps(test) {
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
