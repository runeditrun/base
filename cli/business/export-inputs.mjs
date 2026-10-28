// The non-secret inputs a leased vendor task carries for its shipped adapter
// (the executor task view's `export_inputs`, platform executors/tasks.ts): one
// closed shape per vendor, never a key. Business fills them from the Business's
// inventory evidence and the owner's answers; a window the plan does not state
// is the vendor's full history (`since` null or absent).
//
//   sentry     {organization: {id, slug, region: 'us'|'de'}, window: {since}}
//   pagerduty  {window: {since}, schedules: 'all'} (the plan moves every rota and
//              keeps PagerDuty as the pager)
//   sorry      {page: {host}}
//   uptimerobot needs none.

const DAY = 86_400_000;
const invalid = () => { throw Error('Business returned invalid export inputs for this task.'); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
function closed(value, required, optional = []) {
 plain(value);
 if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
 return value;
}
const sourceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : invalid();
/** The window's start as an ISO instant, or null for the vendor's full history. */
function since(window) {
 closed(window, [], ['since']);
 const value = window.since ?? null;
 if (value === null) return null;
 if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
 return new Date(value).toISOString();
}

const shapes = {
 uptimerobot: () => ({}),
 sentry(value, now) {
  closed(value, ['organization', 'window']);
  const organization = closed(value.organization, ['id', 'slug', 'region']);
  if (!['us', 'de'].includes(organization.region)) invalid();
  const id = Number.isSafeInteger(organization.id) && organization.id >= 0 ? String(organization.id) : sourceId(organization.id);
  // Full history: from the start of time, which Sentry answers with all it retains.
  return { organization: { id, slug: sourceId(organization.slug), region: organization.region }, start: since(value.window) ?? new Date(0).toISOString(), end: new Date(now).toISOString() };
 },
 pagerduty(value, now) {
  closed(value, ['window', 'schedules']);
  if (value.schedules !== 'all') invalid();
  // Rotas move into Oncall beside PagerDuty, so the window runs in whole UTC days
  // to two weeks ahead (the coming overrides; the default of Oncall's own
  // exporter). Oncall compares a schedule's final timeline over at most 31 days
  // and refuses a longer one, so the window starts at the plan's `since` or 31
  // days before its end, whichever is later.
  const until = Math.floor(now / DAY) * DAY + 14 * DAY, start = since(value.window), floor = until - 31 * DAY;
  return { start: new Date(start === null ? floor : Math.max(Math.floor(Date.parse(start) / DAY) * DAY, floor)).toISOString(), end: new Date(until).toISOString() };
 },
 sorry(value) {
  closed(value, ['page']);
  const page = closed(value.page, ['host']);
  if (typeof page.host !== 'string' || page.host.length > 253 || !/^[a-z0-9.-]+$/.test(page.host)) invalid();
  return { page: { host: page.host } };
 },
};
/** What each vendor's inputs are, in the owner's terms, while a task lacks them. */
export const inputNeeds = { sentry: 'its Sentry organization and export window', pagerduty: 'its export window', sorry: "its status page's address" };

/** The shipped adapter's inputs for `vendor` from the leased task's
 * `export_inputs`, or null when the task carries none yet. */
export function exportInputs(vendor, task, now = Date.now()) {
 if (!Object.hasOwn(shapes, vendor)) return null;
 if (vendor === 'uptimerobot') return {};
 if (task.export_inputs === undefined || task.export_inputs === null) return null;
 return shapes[vendor](task.export_inputs, now);
}
