// Test-only vendor responses for the network edge (vendor-edge.mjs), shaped from
// each vendor's documented API: Sentry's organization projects, releases and
// issues (Link-header cursors), PagerDuty's REST users, schedules, overrides
// and escalation policies (offset pages), and Sorry's public status
// page API (`meta.next_page`). Synthetic names only; no real account.

const DAY = 86_400_000, WEEK = 7 * DAY;
const at = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const text = (subject, index) => `${subject}. Update ${index + 1}: the team is working through the checkout path and will post again shortly. `.repeat(12).trim();

// Sentry: one organization, two projects, 40 releases and 120 issues a project in pages of 100.
export const sentry = (() => {
 const organization = { id: '4500001', slug: 'fixture-org', region: 'us' };
 const projects = ['web', 'api'].map((slug, index) => ({ id: String(4501 + index), slug, name: slug === 'web' ? 'Web' : 'API', platform: slug === 'web' ? 'javascript' : 'node', dateCreated: '2023-02-01T00:00:00Z', status: 'active' }));
 const releases = Array.from({ length: 40 }, (_, index) => ({ version: `web@1.${index}.0`, shortVersion: `1.${index}.0`, dateCreated: at(Date.UTC(2026, 0, 1) + index * DAY), newGroups: index % 3, projects: [{ id: 4501, slug: 'web', name: 'Web' }] }));
 const issues = Object.fromEntries(projects.map((project, p) => [project.slug, Array.from({ length: 120 }, (_, index) => ({
  id: String(9000000 + p * 1000 + index), shortId: `${project.slug.toUpperCase()}-${index + 1}`, title: `TypeError: Cannot read properties of undefined (reading 'amount') in charge step ${index}`,
  culprit: `checkout/charge-${index % 7}.js in submitCharge`, level: index % 5 ? 'error' : 'warning', status: index % 4 ? 'unresolved' : 'resolved', count: String(10 + index), userCount: index % 9,
  firstSeen: at(Date.UTC(2026, 6, 1) + index * 3_600_000), lastSeen: at(Date.UTC(2026, 9, 1) + index * 3_600_000), project: { id: project.id, slug: project.slug, name: project.name },
  metadata: { type: 'TypeError', value: `Cannot read properties of undefined (reading 'amount') in charge step ${index}` }, type: 'error', isUnhandled: index % 2 === 0,
 }))]));
 return { organization, projects, releases, issues };
})();

// PagerDuty: 150 users, three weekly schedules (one override each), and one
// escalation policy that pages the first two schedules.
export const pagerduty = (() => {
 const ref = (type, id, summary) => ({ id, type, summary, self: `https://api.pagerduty.com/${type.replace('_reference', '')}s/${id}`, html_url: `https://fixture.pagerduty.com/${id}` });
 const users = Array.from({ length: 150 }, (_, index) => {
  const id = `PU${String(index).padStart(4, '0')}`;
  return { id, type: 'user', name: `Responder ${index}`, email: `responder${index}@chargedesk.example`, time_zone: 'Etc/UTC', color: 'purple', role: 'user', job_title: 'Support engineer',
   summary: `Responder ${index}`, self: `https://api.pagerduty.com/users/${id}`, html_url: `https://fixture.pagerduty.com/users/${id}`, description: 'Synthetic fixture responder for the export test.',
   contact_methods: [ref('email_contact_method_reference', `PC${id}`, 'Default')], notification_rules: [ref('assignment_notification_rule_reference', `PN${id}`, '0 minutes: channel email')], teams: [] };
 });
 const schedules = [0, 1, 2].map(index => ({ id: `PS000${index + 1}`, name: `Primary rota ${index + 1}`, members: [0, 1, 2].map(m => users[index * 3 + m]), anchor: Date.UTC(2026, 0, 5) }));
 const policy = { id: 'PEP001', type: 'escalation_policy', summary: 'ChargeDesk API', name: 'ChargeDesk API', self: 'https://api.pagerduty.com/escalation_policies/PEP001', html_url: 'https://fixture.pagerduty.com/escalation_policies/PEP001',
  num_loops: 0, on_call_handoff_notifications: 'if_has_services', description: 'Pages the primary rotas.',
  escalation_rules: schedules.slice(0, 2).map((schedule, index) => ({ id: `PER${index + 1}`, escalation_delay_in_minutes: 30, targets: [ref('schedule_reference', schedule.id, schedule.name)] })),
  services: [ref('service_reference', 'PSVC001', 'ChargeDesk API')], teams: [] };
 /** The override inside a window: one day, ten days into it, for the rota's fourth member. */
 const override = (schedule, since) => {
  const start = Math.floor((Date.parse(since) + 10 * DAY) / DAY) * DAY;
  return { id: `PO${schedule.id}`, start: at(start), end: at(start + DAY), user: ref('user_reference', users[100].id, users[100].name) };
 };
 /** Who is on call between since and until, after the override, as PagerDuty renders it. */
 function rendered(schedule, since, until, withOverride) {
  const from = Date.parse(since), to = Date.parse(until), swap = withOverride ? override(schedule, since) : null;
  const cuts = new Set([from, to]);
  for (let edge = schedule.anchor + Math.ceil((from - schedule.anchor) / WEEK) * WEEK; edge < to; edge += WEEK) cuts.add(edge);
  if (swap) for (const edge of [Date.parse(swap.start), Date.parse(swap.end)]) if (edge > from && edge < to) cuts.add(edge);
  const points = [...cuts].sort((a, b) => a - b), entries = [];
  for (let index = 0; index < points.length - 1; index++) {
   const start = points[index], turn = Math.floor((start - schedule.anchor) / WEEK);
   const user = swap && start >= Date.parse(swap.start) && start < Date.parse(swap.end) ? users[100] : schedule.members[((turn % 3) + 3) % 3];
   const last = entries.at(-1);
   if (last && last.user.id === user.id) last.end = at(points[index + 1]);
   else entries.push({ start: at(start), end: at(points[index + 1]), user: ref('user_reference', user.id, user.name) });
  }
  return entries;
 }
 function detail(schedule, since, until) {
  const members = schedule.members.map(user => ref('user_reference', user.id, user.name));
  return { schedule: { id: schedule.id, type: 'schedule', summary: schedule.name, name: schedule.name, time_zone: 'Etc/UTC', description: 'Weekly primary rota.',
   self: `https://api.pagerduty.com/schedules/${schedule.id}`, html_url: `https://fixture.pagerduty.com/schedules/${schedule.id}`, users: members, teams: [],
   escalation_policies: schedule.id === 'PS0003' ? [] : [ref('escalation_policy_reference', policy.id, policy.name)],
   schedule_layers: [{ id: `PL${schedule.id}`, name: 'Weekly', start: at(schedule.anchor), end: null, rotation_virtual_start: at(schedule.anchor), rotation_turn_length_seconds: 604800,
    users: members.map(user => ({ user })), restrictions: [], rendered_schedule_entries: rendered(schedule, since, until, false), rendered_coverage_percentage: 100 }],
   final_schedule: { name: 'Final Schedule', rendered_schedule_entries: rendered(schedule, since, until, true), rendered_coverage_percentage: 100 } } };
 }
 return { users, schedules, policy, override, detail };
})();

// Sorry: a public page with 30 components (two parent groups) and 30 notices, 25 to a page.
export const sorry = (() => {
 const host = 'status.fixture-sorry.example', origin = `https://${host}`;
 const page = { name: 'ChargeDesk Status', url: origin, created_at: '2019-03-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
 const components = Array.from({ length: 30 }, (_, index) => ({ id: 101 + index, name: index < 2 ? ['Payments', 'Dashboard'][index] : `Service ${index}`, description: `Component ${index} of the fixture page.`,
  state: index === 7 ? 'degraded' : 'operational', parent_id: index < 2 ? null : 101 + (index % 2), position: index, created_at: '2019-03-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }));
 const notices = Array.from({ length: 30 }, (_, index) => {
  const type = index % 10 === 9 ? 'planned' : index % 10 === 8 ? 'general' : 'unplanned', start = Date.UTC(2026, 0, 1) + index * 5 * DAY, end = start + 3 * 3_600_000;
  const subject = type === 'planned' ? `Scheduled maintenance window ${index}` : type === 'general' ? `Notice about billing emails ${index}` : `Elevated checkout errors ${index}`;
  const states = type === 'planned' ? ['scheduled', 'underway', 'complete'] : type === 'general' ? [null, null, null] : ['investigating', 'identified', 'resolved'];
  const updates = states.map((state, u) => ({ id: 70000 + index * 10 + u, content: text(subject, u), state, created_at: at(start + u * 3_600_000) }));
  return { id: 5001 + index, type, subject, state: type === 'planned' ? 'complete' : type === 'general' ? null : 'resolved', created_at: at(start - DAY), updated_at: at(end),
   began_at: type === 'planned' ? null : at(start), ended_at: at(end), ...(type === 'planned' ? { begins_at: at(start), ends_at: at(end) } : {}),
   url: `${origin}/notices/${5001 + index}`, components: [{ id: 101 + (index % 30) }, { id: 103 + (index % 20) }], updates };
 });
 const list = (rows, resource, number) => {
  const slice = rows.slice((number - 1) * 25, number * 25), more = number * 25 < rows.length;
  return { [resource]: resource === 'notices' ? slice.map(({ updates, ...row }) => row) : slice,
   meta: { count: slice.length, total_count: rows.length, next_page: more ? `/api/v1/${resource}?page=${number + 1}` : null } };
 };
 return { host, origin, page, components, notices, list };
})();
