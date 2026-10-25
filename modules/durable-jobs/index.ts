import { JobError } from './src/codec.ts';
import { request, mutate } from './src/intent.ts';
import { claim, start, quiesce } from './src/leases.ts';
import { list, status } from './src/read.ts';
import { tick } from './src/runtime.ts';
import { Context } from './src/storage.ts';
import { commitUnit } from './src/units.ts';
import type { Authority, Intent, Mutation, Options } from './src/types.ts';

export * from './src/types.ts';
export { JobError } from './src/codec.ts';
export { d1Database, sql } from './src/database.ts';
export { createJobHandler } from './src/http.ts';
export { safeJob } from './src/read.ts';
export function createDurableJobs(options: Options) {
  const context = new Context(options);
  return {
    request: (intent: Intent, authority: Authority) => request(context, intent, authority),
    get: async (id: string, authority: Authority) => { await context.schema(); return context.checked(id, authority); },
    list: (filters: Parameters<typeof list>[1], authority: Authority) => list(context, filters, authority),
    cancel: (id: string, mutation: Mutation, authority: Authority) => mutate(context, 'cancel', id, mutation, authority),
    resume: (id: string, mutation: Mutation, authority: Authority) => mutate(context, 'resume', id, mutation, authority),
    status: (authority: Authority) => status(context, authority),
    diagnostics: (authority: Authority) => status(context, authority),
    start: (options: Parameters<typeof start>[1]) => start(context, options),
    quiesce: (options: Parameters<typeof quiesce>[1]) => quiesce(context, options),
    claim: (options?: Parameters<typeof claim>[1]) => claim(context, options),
    commitUnit: (acquired: Parameters<typeof commitUnit>[1], unit: Parameters<typeof commitUnit>[2]) => commitUnit(context, acquired, unit),
    tick: (options?: Parameters<typeof tick>[1]) => tick(context, options),
    requestUndo: async (id: string, authority: Authority) => { await context.checked(id, authority); throw new JobError('undo_unsupported'); },
  };
}
export type DurableJobs = ReturnType<typeof createDurableJobs>;
