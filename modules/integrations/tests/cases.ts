import type { TestContext } from 'node:test';
export type Case = readonly [string, (context: TestContext) => unknown];

// Every table row owns the same cleanup and mock lifetime as its former test.
export async function runCases(context: TestContext, cases: readonly Case[]) {
  for (const [name, run] of cases) {
    const cleanups: (() => unknown)[] = [];
    const row = new Proxy(context, { get(target, key) {
      if (key === 'name') return name;
      if (key === 'after') return (cleanup: (context: TestContext) => unknown) => cleanups.push(() => cleanup(row));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try { await run(row); }
    catch (error) {
      if (error instanceof Error) error.message = name + ': ' + error.message;
      throw error;
    } finally {
      try { for (const cleanup of cleanups) await cleanup(); }
      finally {
        // A method spy may have captured the fake timer; restore it first.
        context.mock.reset(); context.mock.timers.reset();
      }
    }
  }
}
