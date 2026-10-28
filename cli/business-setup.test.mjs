// One packed public-door journey. Only the HTTP network edge is substituted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';

test('packed business setup uses the owner session, preserves the platform receipt and repeats without mutations', { timeout: 90_000 }, async t => {
 const base = resolve(import.meta.dirname, '..');
 const directory = await mkdtemp(join(base, '.business-setup-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 const launcher = join(packed, 'global/rer.mjs');
 const secret = 'synthetic_session_never_output', cookie = 'session=' + secret;
 const session = join(directory, 'session.json');
 await writeFile(session, JSON.stringify({ cookie }), { mode: 0o600 });
 const requests = [], errors = [];
 const names = ['happytohelp', 'orbit', 'mango', 'lamp', 'uptime', 'spool', 'oncall'];
 const seeds = names.map(app => ({ app, name: app, purpose: 'Synthetic demo ' + app, required: true,
  state: 'available', message: 'Reviewed adoption', source: { commit: 'synthetic-reviewed-' + app }, fixture: { id: app } }));
 let business, profile = {}, draft, revision, plan, apps = [], failure;
 const remote = createServer(async (request, response) => {
  const send = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
   const route = request.url, method = request.method;
   assert.equal(request.headers.cookie, cookie, 'session enters only the authenticated HTTP edge');
   assert.equal(request.headers.origin, origin);
   let text = '';
   for await (const chunk of request) text += chunk;
   assert.ok(!text.includes(secret), 'session is absent from request bodies');
   const body = text ? JSON.parse(text) : undefined;
   requests.push({ method, route, body });
   if (failure) return send(failure, 409);
   if (route === '/api/business/demo/seeds' && method === 'GET') return send({ seeds, dependencies: [{ code: 'demo_issuer_required' }] });
   if (route === '/api/business') {
    if (method === 'GET') return send({ businesses: business ? [business] : [] });
    assert.equal(method, 'POST');
    assert.deepEqual(body, { name: 'Juniper Demo Software (synthetic)', default_hosting: 'self_host', executor_preference: 'local' });
    business = { id: 'demo-business', ...body, primary_domain: null };
    return send({ business });
   }
   const path = route.replace('/api/business/demo-business', '');
   if (path === '/profile') {
    if (method === 'PUT') {
     assert.equal(body.display_name, business.name);
     assert.equal(body.timezone, 'America/New_York');
     profile = { ...profile, ...body };
    } else assert.equal(method, 'GET');
    return send({ profile });
   }
   if (path === '/agents/policy' && method === 'GET') return send({ draft, revision, paused: false });
   if (path === '/agents/policy/revisions' && method === 'POST') {
    assert.deepEqual(body.document, { schema: 'rer-agent-policy/1', catalogue: 'rer-agent-classes/1',
     rules: [{ id: 'internal', class: 'standard', do: 'autonomous' },
      { id: 'owner-first', class: '*', do: 'approval', approver: ['role:owner'], wait: 'P1D' }], spend: { none: true } });
    draft = { revision: 1, document: body.document, document_sha256: 'synthetic-policy-digest' };
    return send({ revision: draft });
   }
   if (path === '/agents/policy/revisions/1/confirm' && method === 'POST') {
    assert.deepEqual(body, { digest: draft.document_sha256 });
    revision = draft; draft = null; return send({ revision });
   }
   if (path === '/apps' && method === 'GET') return send({ apps });
   if (path === '/plans') {
    if (method === 'GET') return send({ data: plan ? [{ id: plan.id, revision: 1 }] : [] });
    assert.equal(method, 'POST');
    assert.deepEqual(body.items, seeds.map(seed => ({ tool: { vendor: 'Demo: ' + seed.name, function: seed.purpose },
     decision: 'runs_beside', target_seed: seed.app, wave: 0 })));
    plan = { id: 'plan1', state: 'draft', items: body.items.map((item, index) => ({ ...item, tool_id: 'tool-' + index })) };
    return send({ data: plan });
   }
   if (path === '/plans/plan1' && method === 'GET') return send({ data: plan });
   if (/^\/inventory\/tool-[0-6]$/.test(path) && method === 'PATCH') {
    assert.deepEqual(body, { answer: 'uses' }); return send({ ok: true });
   }
   if (path === '/plans/plan1/approve' && method === 'POST') {
    assert.deepEqual(body, {});
    plan.state = 'approved';
    plan.snapshot = { sources: Object.fromEntries(seeds.map(seed => [seed.app, seed.source])) };
    apps = names.map((app, index) => ({ app, stage: index < 5 ? 'ready' : 'pending', installation_id: 'installation-' + app,
     ...(index === 6 ? { failure: { code: 'seed_dependency_unavailable' } } : {}) }));
    return send({ data: plan });
   }
   assert.fail('Unexpected Business route: ' + method + ' ' + route);
  } catch (error) { errors.push(error); send({ code: 'fixture_request_invalid' }, 500); }
 });
 await new Promise(resolveListen => remote.listen(0, '127.0.0.1', resolveListen));
 const origin = 'http://127.0.0.1:' + remote.address().port;
 t.after(() => new Promise(resolveClose => { remote.close(resolveClose); remote.closeAllConnections(); }));
 const args = ['--origin', origin, '--session-file', session, '--hosting', 'self_host', '--confirm-demo-policy'];
 async function cli(options) {
  return new Promise((resolveRun, reject) => {
   const argv = [launcher, 'business', 'setup', ...options];
   assert.ok(!argv.some(arg => arg.includes(secret)), 'session never enters subprocess argv');
   const child = spawn(process.execPath, argv, { cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, CI: 'true', RER_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
   let stdout = '', stderr = '';
   const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
   child.stdout.on('data', chunk => { stdout += chunk; });
   child.stderr.on('data', chunk => { stderr += chunk; });
   child.once('error', error => { clearTimeout(deadline); reject(error); });
   child.once('close', code => {
    clearTimeout(deadline);
    assert.ok(![stdout, stderr].some(stream => stream.includes(secret) || stream.includes(cookie)), 'session is absent from both output streams');
    resolveRun({ code, stdout, stderr });
   });
  });
 }
 const help = await cli(['--help']);
 assert.equal(help.code, 0);
 for (const flag of ['--origin', '--session-file', '--hosting', '--confirm-demo-policy', '--json']) assert.ok(help.stdout.includes(flag));

 const first = await cli([...args, '--json']);
 assert.equal(first.code, 2);
 assert.equal(first.stderr, '');
 const receipt = JSON.parse(first.stdout);
 for (const seed of receipt.seeds) assert.equal(typeof seed.message, 'string');
 const structure = report => ({ ...report, seeds: report.seeds.map(seed =>
  Object.fromEntries(Object.entries(seed).filter(([key]) => key !== 'message'))) });
 assert.deepEqual(structure(receipt), {
  schema: 'rer-demo-receipt/1', synthetic: true, business_id: business.id, hosting: 'self_host',
  status: 'dependencies_required', setup_status: 'setup recorded', complete: false,
  policy: { id: business.id + ':1', revision: 1, confirmed: true, paused: false, spend: 'none' },
  counts: { businesses_before: 0, businesses_after: 1, apps_before: 0, apps_after: 7, adopted: 7,
   provisioned: 5, fixtures_loaded: 0, token_ids: 0, plans_created: 1 },
  seeds: seeds.map((seed, index) => ({ app: seed.app, name: seed.name, required: true,
   state: index < 5 ? 'agent_token_issuer_unavailable' : index === 5 ? 'provisioning' : 'failed',
   source: seed.source, fixture: seed.fixture, fixture_state: 'not_loaded', token_ids: [], door_state: 'unavailable',
   installation_id: 'installation-' + seed.app })),
  dependencies: [{ code: 'demo_issuer_required' }],
  proof: { no_policy: 'not_run', with_policy: 'not_run', attribution_audit: 'not_run', pause: 'not_run' },
 });
 const root = '/api/business/demo-business';
 const routes = requests.map(({ method, route }) => method + ' ' + route);
 assert.deepEqual(routes, ['GET /api/business/demo/seeds', 'GET /api/business', 'POST /api/business',
  'GET ' + root + '/profile', 'PUT ' + root + '/profile', 'GET ' + root + '/agents/policy',
  'POST ' + root + '/agents/policy/revisions', 'POST ' + root + '/agents/policy/revisions/1/confirm',
  'GET ' + root + '/agents/policy', 'GET ' + root + '/apps', 'GET ' + root + '/plans', 'POST ' + root + '/plans',
  ...names.map((_name, index) => 'PATCH ' + root + '/inventory/tool-' + index),
  'POST ' + root + '/plans/plan1/approve', 'GET ' + root + '/apps']);
 const mutations = requests.filter(request => request.method !== 'GET').length;
 const second = await cli(args);
 assert.equal(second.code, 2);
 assert.equal(second.stderr, '');
 assert.deepEqual(JSON.parse(second.stdout), { ...receipt, setup_status: 'already provisioned',
  counts: { ...receipt.counts, businesses_before: 1, apps_before: 7, plans_created: 0 } });
 assert.equal(requests.filter(request => request.method !== 'GET').length, mutations);
 assert.deepEqual(requests.slice(routes.length).map(({ method, route }) => method + ' ' + route),
  ['GET /api/business/demo/seeds', 'GET /api/business', 'GET ' + root + '/profile', 'GET ' + root + '/agents/policy',
   'GET ' + root + '/apps', 'GET ' + root + '/plans', 'GET ' + root + '/plans/plan1', 'GET ' + root + '/apps']);
 const beforeRefusals = requests.length;
 await chmod(session, 0o644);
 let result = await cli(args);
 assert.equal(result.code, 1);
 assert.equal(JSON.parse(result.stderr).code, 'demo_session_file_permissions');
 await chmod(session, 0o600);
 result = await cli(args.filter(arg => arg !== '--confirm-demo-policy'));
 assert.equal(result.code, 1);
 assert.equal(JSON.parse(result.stderr).code, 'demo_policy_confirmation_required');
 result = await cli(args.filter((_arg, index) => ![4, 5].includes(index)));
 assert.equal(result.code, 1);
 assert.equal(JSON.parse(result.stderr).code, 'demo_hosting_required');
 result = await cli(args.map(arg => arg === 'self_host' ? 'hosted' : arg));
 assert.equal(result.code, 1);
 assert.equal(JSON.parse(result.stderr).code, 'demo_hosting_invalid');
 for (const hosting of ['managed', 'assisted']) {
  business.default_hosting = hosting;
  result = await cli(args.map(arg => arg === 'self_host' ? hosting : arg));
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).hosting, hosting);
 }
 assert.ok(requests.slice(beforeRefusals).every(request => request.method === 'GET'), 'refusals cause no mutations');
 // Neither untrusted remote fields nor a remote refusal can echo a session.
 failure = { code: secret };
 result = await cli(args);
 assert.equal(result.code, 1);
 assert.equal(JSON.parse(result.stderr).code, '[credential]');
 failure = null;
 seeds[0].message = secret;
 seeds[0].state = 'unavailable';
 result = await cli(args.map(arg => arg === 'self_host' ? 'assisted' : arg));
 assert.equal(result.code, 2);
 assert.equal(JSON.parse(result.stdout).seeds[0].message, '[credential]');
 assert.deepEqual(errors, []);
});
