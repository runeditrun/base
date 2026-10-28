import type { Action, Authority, Context, EntryInput, GuardedRate, NativeLine, Options, Outcome, Resource, Sql, TimeEntry } from '../types.ts';
import { TimeBillingError } from '../errors.ts';
import { policies } from './profiles.ts';

export type Env = { DB: D1Database };
const isFinancial = (action: Action) => ['rate', 'preparePacket', 'commitClaims', 'cancelClaims', 'readPacket', 'lock', 'restoreRecords'].includes(action);
const captureActions = new Set<Action>(['recordEntry', 'startTimer', 'stopTimer', 'submit', 'correct']);
function sql(sql: string, params: Sql['params']): Sql { return { sql, params }; }

export async function context(request: Request, db: D1Database): Promise<Context> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const session = token && await db.prepare('SELECT person_id,agent_id,sponsor_id FROM native_sessions WHERE token=? AND active=1').bind(token).first<{ person_id: string; agent_id: string | null; sponsor_id: string | null }>();
  if (!session) throw new TimeBillingError('forbidden');
  return { installationId: request.headers.get('x-installation') ?? 'source', personId: session.person_id,
    ...(session.agent_id ? { agentId: session.agent_id } : {}), ...(session.sponsor_id ? { sponsorId: session.sponsor_id } : {}) };
}

async function authorize(db: D1Database, ctx: Context, action: Action, resource: Resource): Promise<Authority> {
  const member = await db.prepare('SELECT can_finance FROM native_memberships WHERE installation=? AND person_id=? AND work_id=? AND active=1').bind(ctx.installationId, ctx.personId, resource.work.id).first<{ can_finance: number }>();
  const policy = await db.prepare('SELECT revision FROM native_access_policy WHERE installation=?').bind(ctx.installationId).first<{ revision: string }>();
  const financial = isFinancial(action) || action === 'exportRecords';
  const capability = financial ? 'm.can_finance=1' : action === 'decide' ? 'm.can_review=1' : captureActions.has(action) ? 'm.can_capture=1' : 'm.can_read=1';
  const scoped = captureActions.has(action) && resource.timekeeperId ? ' AND (m.timekeeper_id IS NULL OR m.timekeeper_id=?)' : '';
  const params: (string | number | null)[] = [ctx.installationId, ctx.personId, resource.work.id, resource.work.kind, policy?.revision ?? 'missing'];
  if (scoped) params.push(resource.timekeeperId!);
  return {
    projection: member?.can_finance ? 'financial' : 'time', policyRevision: policy?.revision ?? 'missing',
    predicate: sql(`EXISTS(SELECT 1 FROM native_memberships m JOIN native_people p ON p.installation=m.installation AND p.id=m.person_id JOIN native_work w ON w.installation=m.installation AND w.id=m.work_id JOIN native_access_policy a ON a.installation=m.installation WHERE m.installation=? AND m.person_id=? AND m.work_id=? AND ?='project' AND a.revision=? AND m.active=1 AND p.active=1 AND w.active=1 AND ${capability}${scoped})`, params),
  };
}

async function entryGuard(ctx: Context, entry: EntryInput): Promise<Sql> {
  const policy = policies.find(candidate => candidate.id === entry.policyId);
  return sql(`EXISTS(SELECT 1 FROM native_work w JOIN native_people p ON p.installation=w.installation JOIN native_sources s ON s.installation=w.installation AND s.work_id=w.id JOIN native_capture_policy c ON c.installation=w.installation WHERE w.installation=? AND w.id=? AND w.active=1 AND p.id=? AND p.active=1 AND s.kind=? AND s.id=? AND s.revision=? AND s.active=1 AND c.id=? AND c.revision=? AND c.active=1)`, [ctx.installationId, entry.work.id, entry.timekeeperId, entry.source.kind, entry.source.id, entry.source.revision, entry.policyId, policy?.revision ?? 'missing']);
}

async function selectRate(db: D1Database, ctx: Context, entry: TimeEntry, stage: 'entry' | 'approval' | 'invoice'): Promise<GuardedRate> {
  const rate = await db.prepare('SELECT * FROM native_rates WHERE installation=? AND work_id=?').bind(ctx.installationId, entry.work.id).first<{ id: string; revision: string; currency: string; minor_numerator: string; duration_denominator: string; effective_at: string }>();
  if (!rate) throw new TimeBillingError('not_found', 'Native service rate is missing.');
  return {
    rate: { id: rate.id, revision: rate.revision, currency: rate.currency, minorNumerator: rate.minor_numerator, durationMsDenominator: rate.duration_denominator,
      effectiveAt: rate.effective_at, selectedAt: stage, source: { kind: 'native-rate', id: rate.id, revision: rate.revision } },
    guard: sql('EXISTS(SELECT 1 FROM native_rates WHERE installation=? AND work_id=? AND id=? AND revision=? AND minor_numerator=? AND duration_denominator=? AND currency=?)', [ctx.installationId, entry.work.id, rate.id, rate.revision, rate.minor_numerator, rate.duration_denominator, rate.currency]),
  };
}

async function reviewGuard(db: D1Database, ctx: Context, entry: TimeEntry): Promise<{ predicate: Sql; policyRevision: string }> {
  const policy = await db.prepare('SELECT revision FROM native_review_policy WHERE installation=? AND work_id=?').bind(ctx.installationId, entry.work.id).first<{ revision: string }>();
  return { policyRevision: policy?.revision ?? 'missing', predicate: sql(`EXISTS(SELECT 1 FROM native_review_policy r JOIN native_memberships m ON m.installation=r.installation AND m.work_id=r.work_id WHERE r.installation=? AND r.work_id=? AND r.revision=? AND r.enabled=1 AND m.person_id=? AND m.active=1 AND m.can_review=1 AND m.person_id<>? AND m.person_id<>?)`, [ctx.installationId, entry.work.id, policy?.revision ?? 'missing', ctx.personId, entry.timekeeperId, entry.preparerId]) };
}

function nativeLineGuard(ctx: Context, line: NativeLine): Promise<Sql> {
  return Promise.resolve(sql('EXISTS(SELECT 1 FROM native_adjustments WHERE installation=? AND id=? AND revision=? AND amount_minor=? AND currency=? AND engine=? AND calculation_revision=?)', [ctx.installationId, line.source.id, line.source.revision, line.amountMinor, line.currency, line.calculation.engine, line.calculation.revision]));
}

function nativeOutcome(outcome: Outcome): Promise<readonly Sql[]> {
  const statements = [sql('INSERT INTO native_outcomes(installation,person_id,action,operation_key,subject,result) VALUES(?,?,?,?,?,?)', [outcome.context.installationId, outcome.context.personId, outcome.action, outcome.operationKey, outcome.subject, JSON.stringify(outcome.result)])];
  if (outcome.action === 'commitClaims' || outcome.action === 'cancelClaims') {
    const packet = outcome.result as { id: string; state: string; totalMinor: string; currency: string };
    statements.push(sql(`INSERT INTO native_bills(installation,packet_id,state,amount_minor,currency) VALUES(?,?,?,?,?) ON CONFLICT(installation,packet_id) DO UPDATE SET state=excluded.state`, [outcome.context.installationId, packet.id, packet.state, packet.totalMinor, packet.currency]));
  }
  return Promise.resolve(statements);
}

export async function options(db: D1Database, ctx: Context): Promise<Options> {
  const clock = await db.prepare('SELECT "current_time" FROM native_control WHERE installation=?').bind(ctx.installationId).first<{ current_time: string }>();
  if (!clock) throw new TimeBillingError('forbidden', 'Native installation is unavailable.');
  return { database: db, policies, authorize: (context, action, resource) => authorize(db, context, action, resource),
    entryGuard: (context, entry) => entryGuard(context, entry), selectRate: (context, entry, stage) => selectRate(db, context, entry, stage),
    reviewGuard: (context, entry) => reviewGuard(db, context, entry), nativeLineGuard, nativeOutcome,
    now: () => new Date(clock.current_time) };
}
