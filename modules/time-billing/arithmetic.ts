import { demand, LIMITS } from './errors.ts';
import type { CapturePolicy, Duration, RateSnapshot, RatedTime, Rounding, TimeEntry } from './types.ts';

const units = { ms: 1n, second: 1000n, minute: 60000n, hour: 3600000n };
const stages = ['entry', 'approval', 'invoice'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): asserts value is string {
  demand(typeof value === 'string' && value.length > 0 && value.length <= LIMITS.idLength,
    'invalid', 'Expected a bounded nonempty identifier');
}

function integer(value: unknown, positive = false): bigint {
  demand(typeof value === 'string' && /^[0-9]+$/.test(value), 'invalid', 'Expected nonnegative integer text');
  demand(value.length <= LIMITS.integerDigits, 'capacity', 'Integer exceeds supported precision');
  const result = BigInt(value);
  demand(!positive || result > 0n, 'invalid', 'Expected a positive integer');
  return result;
}

function bounded(value: bigint): string {
  const result = value.toString();
  demand(result.length <= LIMITS.integerDigits, 'capacity', 'Result exceeds supported precision');
  return result;
}

function validateRounding(rounding: Rounding): void {
  demand(object(rounding), 'invalid', 'Missing rounding rule');
  integer(rounding.incrementMs, true);
  demand(['ceil', 'floor', 'half-up', 'exact'].includes(rounding.mode), 'invalid', 'Unknown rounding mode');
  const minimum = rounding.minimumMs === undefined ? 0n : integer(rounding.minimumMs);
  demand(rounding.mode !== 'exact' || minimum === 0n, 'invalid', 'Exact rounding cannot impose a minimum');
}

export function validatePolicy(policy: CapturePolicy): void {
  demand(object(policy), 'invalid', 'Missing capture policy');
  text(policy.id);
  text(policy.revision);
  demand(policy.review === 'required' || policy.review === 'none', 'invalid', 'Unknown review policy');
  demand(stages.includes(policy.rateStage), 'invalid', 'Unknown rate stage');
  demand(policy.review === 'required' || policy.rateStage !== 'approval', 'invalid', 'Approval rates require review');
  demand(policy.manual === null || object(policy.manual), 'invalid', 'Missing manual capture rule');
  if (policy.manual !== null) validateRounding(policy.manual);
  demand(policy.timer === null || object(policy.timer), 'invalid', 'Missing timer capture rule');
  if (policy.timer !== null) {
    validateRounding(policy.timer.rounding);
    demand(['start', 'stop'].includes(policy.timer.dateBasis), 'invalid', 'Unknown timer date basis');
    demand(['person', 'work', 'allow'].includes(policy.timer.overlap), 'invalid', 'Unknown timer overlap rule');
  }
  demand(policy.billing === null || object(policy.billing), 'invalid', 'Missing billing rule');
  if (policy.billing !== null) {
    validateRounding(policy.billing.rounding);
    demand(['half-up', 'floor', 'ceil'].includes(policy.billing.money), 'invalid', 'Unknown money rounding rule');
  }
}

/** Parses only explicit ISO instants at millisecond precision; Date.parse alone normalizes invalid dates. */
function instant(value: unknown): number {
  demand(typeof value === 'string', 'invalid', 'Expected an ISO timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  demand(match, 'invalid', 'Expected an ISO timestamp with an explicit offset');
  const [, year, month, day, hour, minute, second, , offset] = match;
  const date = `${year}-${month}-${day}`;
  validateDate(date);
  demand(Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59,
    'invalid', 'Invalid timestamp time');
  if (offset !== 'Z') demand(Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59,
    'invalid', 'Invalid timestamp offset');
  const result = Date.parse(value);
  demand(Number.isSafeInteger(result), 'invalid', 'Invalid timestamp');
  return result;
}

function validateDate(value: unknown): asserts value is string {
  demand(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'invalid', 'Expected a calendar date');
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  demand(Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value,
    'invalid', 'Invalid calendar date');
}

function dateFormatter(timezone: unknown): Intl.DateTimeFormat {
  text(timezone);
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    demand(false, 'invalid', 'Invalid timezone');
  }
}

function workDate(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(timestamp);
  const part = (type: string): string => parts.find(value => value.type === type)!.value;
  const result = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  validateDate(result);
  return result;
}

export function validateDuration(duration: Duration): void {
  demand(object(duration), 'invalid', 'Missing duration');
  const observed = integer(duration.milliseconds);
  demand(object(duration.original), 'invalid', 'Missing original duration');
  const { value, unit } = duration.original;
  demand(typeof unit === 'string' && Object.hasOwn(units, unit), 'invalid', 'Unknown duration unit');
  demand(typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(value),
    'invalid', 'Expected nonnegative decimal duration text');
  const [whole, fraction = ''] = value.split('.');
  demand(whole.length <= LIMITS.integerDigits && fraction.length <= LIMITS.decimalPlaces,
    'capacity', 'Duration exceeds supported precision');
  const numerator = BigInt(whole + fraction) * units[unit];
  const denominator = 10n ** BigInt(fraction.length);
  demand(numerator % denominator === 0n && numerator / denominator === observed,
    'invalid', 'Original duration does not match observed milliseconds');
  demand(['interval', 'manual', 'active-effort'].includes(duration.basis), 'invalid', 'Unknown duration basis');
  const formatter = dateFormatter(duration.timezone);
  validateDate(duration.workDate);
  // A timer policy marker includes both its revision and its chosen date boundary.
  demand(typeof duration.datePolicy === 'string' && duration.datePolicy.length > 0 &&
    duration.datePolicy.length <= LIMITS.idLength * 2 + 7, 'invalid', 'Missing date policy');
  if (duration.basis === 'interval') {
    demand(object(duration.interval), 'invalid', 'Interval duration requires boundaries');
    const start = instant(duration.interval.start);
    const end = instant(duration.interval.end);
    demand(end >= start && BigInt(end) - BigInt(start) === observed,
      'invalid', 'Interval boundaries do not match observed milliseconds');
    const basis = duration.datePolicy.split(':').at(-1);
    if (basis === 'start' || basis === 'stop') demand(
      duration.workDate === workDate(basis === 'start' ? start : end, formatter),
      'invalid', 'Work date does not match interval date policy');
  } else {
    demand(duration.interval === undefined, 'invalid', 'Only interval durations may contain boundaries');
  }
}

export function validateRate(rate: RateSnapshot): void {
  demand(object(rate), 'invalid', 'Missing rate snapshot');
  text(rate.id);
  text(rate.revision);
  demand(typeof rate.currency === 'string' && /^[A-Z]{3}$/.test(rate.currency), 'invalid', 'Invalid currency');
  integer(rate.minorNumerator);
  integer(rate.durationMsDenominator, true);
  instant(rate.effectiveAt);
  demand(stages.includes(rate.selectedAt), 'invalid', 'Unknown rate selection stage');
  demand(object(rate.source), 'invalid', 'Missing rate source');
  text(rate.source.kind);
  text(rate.source.id);
  text(rate.source.revision);
}

function quotient(numerator: bigint, denominator: bigint, mode: 'ceil' | 'floor' | 'half-up'): bigint {
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  return whole + ((mode === 'ceil' && remainder > 0n) ||
    (mode === 'half-up' && remainder * 2n >= denominator) ? 1n : 0n);
}

export function roundDuration(milliseconds: string, rounding: Rounding): string {
  const observed = integer(milliseconds);
  validateRounding(rounding);
  if (rounding.mode === 'exact') return observed.toString();
  const increment = integer(rounding.incrementMs, true);
  const rounded = quotient(observed, increment, rounding.mode) * increment;
  const minimum = rounding.minimumMs === undefined ? 0n : integer(rounding.minimumMs);
  return bounded(rounded < minimum ? minimum : rounded);
}

export function rateTime(entry: TimeEntry, rate: RateSnapshot): RatedTime {
  validatePolicy(entry.policy);
  validateDuration(entry.duration);
  validateRate(rate);
  demand(entry.policy.billing !== null, 'unsupported', 'Policy does not support billing');
  demand(rate.selectedAt === entry.policy.rateStage, 'invalid', 'Rate selection stage does not match policy');
  let capturedMs = entry.duration.milliseconds;
  if (entry.duration.basis === 'manual') {
    demand(entry.policy.manual !== null, 'unsupported', 'Policy does not support manual capture');
    capturedMs = roundDuration(capturedMs, entry.policy.manual);
  } else if (entry.duration.basis === 'interval') {
    demand(entry.policy.timer !== null, 'unsupported', 'Policy does not support timer capture');
    demand(entry.duration.datePolicy === `${entry.policy.id}@${entry.policy.revision}:${entry.policy.timer.dateBasis}`,
      'invalid', 'Timer date policy does not match capture policy');
    capturedMs = roundDuration(capturedMs, entry.policy.timer.rounding);
  }
  const billedMs = roundDuration(capturedMs, entry.policy.billing.rounding);
  const amountMinor = bounded(quotient(BigInt(billedMs) * BigInt(rate.minorNumerator),
    BigInt(rate.durationMsDenominator), entry.policy.billing.money));
  return {
    kind: 'time', entryId: entry.id, entryRevision: entry.revision, source: entry.source,
    observedMs: entry.duration.milliseconds, capturedMs, billedMs, amountMinor, currency: rate.currency,
    policy: `${entry.policy.id}@${entry.policy.revision}`, rate: structuredClone(rate),
  };
}

export function timerDuration(start: string, end: string, timezone: string, policy: CapturePolicy): Duration {
  validatePolicy(policy);
  demand(policy.timer !== null, 'unsupported', 'Policy does not support timers');
  const started = instant(start);
  const stopped = instant(end);
  demand(stopped >= started, 'invalid', 'Timer stopped before it started');
  const milliseconds = bounded(BigInt(stopped) - BigInt(started));
  const formatter = dateFormatter(timezone);
  return {
    milliseconds, original: { value: milliseconds, unit: 'ms' }, basis: 'interval', timezone,
    workDate: workDate(policy.timer.dateBasis === 'start' ? started : stopped, formatter),
    datePolicy: `${policy.id}@${policy.revision}:${policy.timer.dateBasis}`, interval: { start, end },
  };
}
