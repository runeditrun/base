// Table rows use separate cleanup contexts, like the registrations they replace.
// This also keeps the D1 runtime pool and its lease scoped to one row at a time.
export async function runCases(context, cases) {
  for (const [name, run] of cases) {
    const cleanups = [];
    const row = new Proxy(context, { get(target, key) {
      if (key === 'name') return name;
      if (key === 'after') return cleanup => cleanups.push(() => cleanup(row));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await run(row);
    } catch (error) {
      if (error instanceof Error) error.message = name + ': ' + error.message;
      throw error;
    } finally {
      try {
        for (const cleanup of cleanups) await cleanup();
      } finally {
        // Restore method spies before timers: a spy may have captured a fake timer.
        context.mock.reset();
        context.mock.timers.reset();
      }
    }
  }
}
