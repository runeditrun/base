export function check(value, message) { if (!value) throw new Error(message); }
function ordered(value) {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
export function equal(actual, expected, message) {
  if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(expected))) throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
export async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function rejects(run, code) {
  try { await run(); } catch (error) { equal(error.code, code, 'public error code'); return; }
  throw new Error(`Expected public command to reject with ${code}`);
}
export const WORK = Object.freeze({ kind: 'project', id: 'project-1' });
export const OTHER = Object.freeze({ kind: 'project', id: 'project-2' });
export function write(id, expectedRevision = 0, suffix = 'write') { return { id, expectedRevision, operationKey: `${id}:${suffix}` }; }
export function duration(milliseconds = '36000', value = '0.01', unit = 'hour') {
  return { milliseconds, original: { value, unit }, basis: 'manual', timezone: 'Australia/Brisbane', workDate: '2026-10-28', datePolicy: 'native-work-date' };
}
export async function input(runtime, profile, id, overrides = {}) {
  const entry = { id, work: WORK, timekeeperId: 'worker', duration: duration(), billable: true, category: 'service', source: { kind: 'native-task', id: `task-${id}`, revision: '1' }, policyId: profile.policyId, ...overrides };
  await runtime.source(entry.source, entry.work);
  return entry;
}
export async function record(runtime, profile, id, overrides = {}) {
  return runtime.command('recordEntry', { ...await input(runtime, profile, id, overrides), ...write(id) });
}
export async function approve(runtime, profile, entry) {
  if (!profile.review) return entry;
  const submitted = await runtime.command('submit', write(entry.id, entry.revision, 'submit'));
  return runtime.command('decide', { ...write(entry.id, submitted.revision, 'approve'), decision: 'approve', reason: 'Native eligible reviewer checked the work.' }, 'reviewer');
}
export async function withRuntime(adapter, run, options = {}) {
  for (const profile of adapter.profiles) {
    const runtime = await adapter.open({ profile, ...options });
    try { await run(runtime, profile); } finally { await runtime.close(); }
  }
}
