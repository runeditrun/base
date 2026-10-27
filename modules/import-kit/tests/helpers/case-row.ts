import type { TestContext } from 'node:test';

export type CaseRow = [name: string, run: (context: TestContext) => unknown];

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
  const errors: unknown[] = [];
  try { await run(context); } catch (error) { errors.push(error); }
  for (const hook of cleanup) {
    try { await hook(); } catch (error) { errors.push(error); }
  }
  t.mock.timers.reset();
  t.mock.reset();
  if (errors.length) throw new AggregateError(errors, name);
}

/** Run every scenario even after a failure, retaining each original case name. */
export async function caseRows(t: TestContext, rows: CaseRow[]): Promise<void> {
  const errors: unknown[] = [];
  for (const [name, run] of rows) {
    try { await caseRow(t, name, run); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => (error as Error).message).join('\n'));
}
