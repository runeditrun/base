import type { Context, Options, TimeBilling } from './types.ts';
import { demand, LIMITS } from './errors.ts';
import { identifier } from './encoding.ts';
import { validatePolicy } from './arithmetic.ts';
import * as entries from './entries.ts';
import * as timers from './timers.ts';
import * as billing from './billing.ts';
import * as reads from './reads.ts';
import * as archive from './archive.ts';
export type * from './types.ts';
export { TimeBillingError, LIMITS } from './errors.ts';
export { rateTime, roundDuration, timerDuration, validateDuration, validateRate, validatePolicy } from './arithmetic.ts';
export { verifyArchive } from './archive.ts';
export function createTimeBilling(options: Options): TimeBilling {
  demand(options.policies.length > 0 && options.policies.length <= LIMITS.policies, 'capacity');
  options.policies.forEach(validatePolicy); options.policies.forEach(p => { identifier(p.id); identifier(p.revision); });
  demand(new Set(options.policies.map(p => p.id)).size === options.policies.length);
  const stable: Options = { ...options, policies: structuredClone(options.policies) };
  const env = (ctx: Context) => ({ options: stable, ctx: structuredClone(ctx) });
  return {
    recordEntry: (c, i) => entries.recordEntry(env(c), i), startTimer: (c, i) => timers.startTimer(env(c), i), stopTimer: (c, i) => timers.stopTimer(env(c), i),
    submit: (c, i) => entries.submit(env(c), i), decide: (c, i) => entries.decide(env(c), i), correct: (c, i) => entries.correct(env(c), i), lock: (c, i) => entries.lock(env(c), i),
    rate: (c, i) => billing.rate(env(c), i), preparePacket: (c, i) => billing.preparePacket(env(c), i), commitClaims: (c, i) => billing.commitClaims(env(c), i), cancelClaims: (c, i) => billing.cancelClaims(env(c), i),
    readEntry: (c, i) => reads.readEntry(env(c), i), readPacket: (c, i) => reads.readPacket(env(c), i), exportRecords: (c, i) => archive.exportRecords(env(c), i), restoreRecords: (c, i) => archive.restoreRecords(env(c), i),
  };
}
