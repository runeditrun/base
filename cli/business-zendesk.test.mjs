import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { server } from './fixtures/business/server.mjs';
import { zendeskDoor } from './fixtures/business/zendesk-door.mjs';
import { key, token, fixture, origin, blob } from './fixtures/business/zendesk-data.mjs';
import { ZendeskStore, materialize, storePath } from './business/vendors/zendesk-store.mjs';
import { encodeSnapshot } from './business/vendors/zendesk-encode.mjs';
import { hash } from './business/vendors/common.mjs';

const base = resolve(import.meta.dirname, '..'), fixtures = join(import.meta.dirname, 'fixtures/business');
let root;
before(async () => { root = await mkdtemp(join(base, '.business-connect-zendesk-')); });
after(() => rm(root, { recursive: true, force: true }));
async function cli(home, args, { terminal = false, input = '', scenario = 'Z0' } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${join(fixtures, 'register.mjs')} --import=${join(fixtures, 'zendesk-edge.mjs')}`, ZENDESK_CASE: scenario };
 return new Promise((resolveRun,reject) => {
  const child = spawn(terminal ? 'python3' : process.execPath, [...(terminal ? [join(fixtures, 'terminal.py'), process.execPath] : []), join(base, 'bin/rer.mjs'), 'business', ...args], { cwd: home, env, stdio: ['pipe','pipe','pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', reject);
  child.once('close', (code,signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
  child.stdin.end(input);
 });
}
async function setup(t, name) {
 const home = join(root, name), remote = await server(t), seed = await zendeskDoor(t);
 remote.state.pollSeconds = 1; remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 let approved = false;
 const pairing = cli(home, ['connect','--code','ABCD-1234','--origin',remote.origin]);
 for (let attempt = 0; attempt < 100 && !approved; attempt++) {
  const response = await fetch(`${remote.origin}/api/business/biz/pairings/pair1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation_number: '246810', confirmed: true }) });
  approved = response.ok;
  if (!approved) await new Promise(resolve => setTimeout(resolve, 20));
 }
 const connected = await pairing; assert.equal(connected.code, 0, connected.stderr);
 const added = await cli(home, ['vendor-key','add','zendesk'], { terminal: true, input: key + '\n' });
 assert.equal(added.code, 0, added.stderr + added.stdout); assert.ok(!added.stdout.includes(key));
 remote.state.exportVendor = 'zendesk'; remote.state.door = seed;
 const directory = join(home, '.rer/business'), path = storePath(directory, 'biz', origin);
 const task = (id = 'fixture-zendesk', inputs = {}) => {
  remote.state.tasks = [{ task_id: id, kind: 'export.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Export Zendesk history', export_inputs: { account: { subdomain: 'fixture-zendesk' }, ...inputs } }];
 };
 task();
 return { home, remote, seed, directory, path, task, run: options => cli(home, ['run','--once'], options) };
}
const requests = async home => (await readFile(join(home,'zendesk-requests.ndjson'),'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const census = path => readFile(join(path,'census.json'),'utf8').then(JSON.parse);
async function result(path) { const store = await new ZendeskStore(path).start(); return encodeSnapshot(store, { origin }); }

// Each POINT goes through the public rer business subprocess, OS process edge,
// Zendesk network edge, and (for successful snapshots) the real HTTP door.
test('P1 P2 P4 P7 P8: Z0 archived tickets, exact census, paging, privacy and one public-door v1 plan', async t => {
 const s = await setup(t, 'Z0');
 const output = await s.run(); assert.equal(output.code, 0, output.stderr);
 assert.equal(s.seed.state.plans.length, 1);
 const exported = await result(s.path), rows = exported.bytes.toString().trim().split('\n').map(JSON.parse), data = await materialize(exported.store ?? await new ZendeskStore(s.path).start());
 assert.equal(rows.length, 7); assert.equal(exported.kind, 'bundle');
 const tickets = rows.filter(row => row.ticket).map(row => row.ticket);
 assert.deepEqual(tickets.map(row => row.id), [10,900001]); assert.equal(tickets[0].subject, 'last version');
 assert.deepEqual(tickets.map(row => row.comments.length), [2,2]); assert.equal(tickets[0].comments[1].public, false);
 const original = fixture().latest;
 for (const name of ['encoded_id','via','metadata']) assert.deepEqual(tickets[0][name], original[name]);
 assert.equal(rows.find(row => row.article).article.user_segment_id, 5);
 assert.deepEqual(rows.find(row => row.article).article.user_segment_ids, [5]);
 const c = await census(s.path);
 assert.deepEqual(c.tickets, { unique: 3, deleted: 1, deletedIdsSha256: hash('20\n'), byStatus: { open: 1, deleted: 1, closed: 1 }, maxId: '900001' });
 assert.deepEqual(c.comments, { total: 4, public: 2, private: 2 });
 assert.deepEqual(c.attachments, { referenced: 4, fetched: 2, bytes: blob.length * 2, uniqueBlobs: 1, undelivered: { deleted: 1, malware_found: 1 } });
 assert.deepEqual(c.users, { unique: 2, inactive: 1, withoutEmail: 1 });
 assert.deepEqual(c.guide, { available: true, articles: 1, restricted: 1, draft: 1, translations: 3, sections: 1, categories: 1, segments: 1 });
 assert.equal(c.credentialShapesRemoved, 1); assert.deepEqual(c.credentialRemovals, [{ kind: 'ticket', id: '10', pointer: '/comments/0/body' }]);
 assert.match(tickets[0].comments[0].body, /\[removed\]/); assert.equal(c.highWater, 130);
 const blobs = [...data.attachments.values()].filter(item => item.blob).map(item => item.blob.sha256); assert.equal(new Set(blobs).size, 1);
 const log = await requests(s.home); assert.equal(log.filter(item => item.method === 'POST').length, 1); assert.ok(log.filter(item => item.path !== '/oauth/tokens').every(item => item.method === 'GET'));
 assert.ok(!log.some(item => item.path === '/api/v2/tickets'));
 for (const text of [output.stdout, output.stderr, JSON.stringify(s.remote.state.requests), exported.bytes.toString(), await readFile(join(s.directory,'state.json'),'utf8'), JSON.stringify(await readdir(s.path))]) {
  for (const secret of [key, token, ...Object.values(JSON.parse(key))]) assert.ok(!text.includes(secret));
 }
 assert.equal((await stat(s.path)).mode & 0o777, 0o700);
 for (const name of await readdir(join(s.path,'objects'))) {
  const bytes = await readFile(join(s.path,'objects',name));
  for (const secret of [key, token, ...Object.values(JSON.parse(key))]) assert.ok(!bytes.includes(Buffer.from(secret)));
  assert.equal((await stat(join(s.path,'objects',name))).mode & 0o777, 0o600);
 }
 assert.ok((await readFile(join(s.path,'checkpoint.json'))).length < 128 * 1024);
 assert.equal(s.seed.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get().n, 0);
 const uploaded = Buffer.concat(s.seed.runtime.native().prepare('SELECT base64 FROM ik_door_chunks ORDER BY ordinal').all().map(row => Buffer.from(row.base64, 'base64')));
 assert.deepEqual(uploaded, exported.bytes);
 const transfer = JSON.parse(await readFile(join(s.path, 'transfer.json'), 'utf8'));
 assert.equal(transfer.bundleSha256, hash(uploaded));
 t.diagnostic(`PROBE P8 Z0: plan_id=${s.seed.state.plans[0].planId} upload_id=${s.seed.state.plans[0].uploadId} sha256=${hash(exported.bytes)} records=7 native_writes=0`);
});

test('P3: SIGKILL in A, B and F resumes byte-equal records and census; edited store is INVALID_CHECKPOINT', async t => {
 const uninterrupted = await setup(t, 'resume-baseline'); assert.equal((await uninterrupted.run()).code, 0);
 const expected = await result(uninterrupted.path);
 for (const phase of ['A','B','F']) {
  const s = await setup(t, `resume-${phase}`), killed = await s.run({ scenario: `kill-${phase}` });
  assert.equal(killed.signal, 'SIGKILL');
  // The supervisor's killed lease is recoverable under the existing contract.
  const resumed = await s.run({ scenario: `kill-${phase}` }); assert.equal(resumed.code, 0, resumed.stderr);
  const actual = await result(s.path); assert.deepEqual(actual.bytes, expected.bytes); assert.deepEqual(actual.census, expected.census);
  t.diagnostic(`PROBE P3 phase=${phase} records_sha256=${hash(actual.bytes)} byte_equal=true`);
 }
 const s = uninterrupted, store = await new ZendeskStore(s.path).start(), first = store.events.find(event => event.raw).raw;
 await writeFile(join(s.path,first.file), 'edited');
 const before = (await requests(s.home)).length;
 s.task('edited'); const edited = await s.run(); assert.equal(edited.code, 1); assert.match(edited.stderr, /INVALID_CHECKPOINT/);
 assert.equal((await requests(s.home)).length, before, 'stale store refuses before token mint');
});

test('P4: hidden key input only and write scope refuses before any data GET', async t => {
 const s = await setup(t, 'write-scope');
 const piped = await cli(s.home, ['vendor-key','add','zendesk'], { input: key + '\n' }); assert.equal(piped.code, 1); assert.match(piped.stderr, /hidden input/);
 const output = await s.run({ scenario: 'write-scope' }); assert.equal(output.code, 1); assert.match(output.stderr, /KEY_NOT_READ_ONLY/);
 assert.deepEqual((await requests(s.home)).map(row => row.path), ['/oauth/tokens','/api/v2/oauth/tokens/current']);
});

test('P5: redirect credentials, refused targets, invalid pagination and size failures', async t => {
 for (const scenario of ['redirect-public','redirect-http','redirect-ip','redirect-userinfo','redirect-local','redirect-port','bad-page','size-mismatch']) {
  const s = await setup(t, scenario), output = await s.run({ scenario }), log = await requests(s.home);
  if (scenario === 'bad-page' || scenario === 'size-mismatch') { assert.equal(output.code, 1); assert.match(output.stderr, scenario === 'bad-page' ? /INVALID_PAGINATION/ : /ATTACHMENT_SIZE_MISMATCH/); }
  else {
   assert.equal(output.code, 0, output.stderr);
   const c = await census(s.path);
   if (scenario === 'redirect-public') { assert.ok(log.some(row => !row.account)); assert.ok(log.filter(row => !row.account).every(row => !row.credentialPresent)); }
   else { assert.ok(log.every(row => row.account)); assert.equal(c.attachments.undelivered.refused_location, 2); }
  }
  for (const secret of [key,token,'example.com','internal.local']) assert.ok(!(output.stderr).includes(secret));
 }
});

test('P6: bounded Retry-After and conservative incremental pacing', async t => {
 for (const scenario of ['retry-2','retry-600','retry-four','no-headers']) {
  const s = await setup(t, scenario), output = await s.run({ scenario }), log = (await requests(s.home)).filter(row => row.path.includes('/incremental/tickets/'));
  if (scenario === 'retry-600' || scenario === 'retry-four') {
   assert.equal(output.code, 1); assert.match(output.stderr, /RATE_LIMITED/); assert.equal(log.length, scenario === 'retry-600' ? 1 : 4);
   assert.equal((await new ZendeskStore(s.path).start()).state.phase, 'A');
  } else {
   assert.equal(output.code, 0, output.stderr);
   assert.ok(log[1].at - log[0].at >= (scenario === 'no-headers' ? 5990 : 1990));
  }
 }
});

test('P8 package dependency and P9 sweep, census-only and retire signal', async t => {
 const large = await setup(t, 'large'), unsupported = await large.run({ scenario: 'Z' });
 assert.equal(unsupported.code, 1); assert.match(unsupported.stderr, /SEED_PACKAGE_UNSUPPORTED/);
 const packed = await result(large.path); assert.equal(packed.kind, 'package'); assert.equal(large.seed.state.plans.length, 0); assert.equal(large.seed.requests.length, 0);
 assert.ok([...packed.files.keys()].includes('guide/user_segments.ndjson'));
 const s = await setup(t, 'lifetime'); assert.equal((await s.run()).code, 0);
 await s.seed.applyLatest();
 const baseline = (await result(s.path)).bytes;
 s.task('sweep', { mode: 'sweep', highWater: 130 }); const swept = await s.run({ scenario: 'sweep-change' }); assert.equal(swept.code, 0, swept.stderr);
 const complete = await result(s.path);
 assert.notDeepEqual(complete.bytes, baseline);
 const rows = complete.bytes.toString().trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.filter(row => row.ticket).map(row => row.ticket.id), [10,900001]);
 assert.equal(rows[0].ticket.subject, 'swept last version');
 assert.equal(rows[0].ticket.comments[1].body, 'Updated private reply');
 assert.equal(complete.census.highWater, 140);
 const log = await requests(s.home); assert.ok(log.some(row => row.path.includes('start_time=130')));
 s.task('census', { mode: 'census', highWater: 140 }); const before = log.length, counted = await s.run({ scenario: 'sweep-change' });
 assert.match(counted.stdout + counted.stderr, /3 tickets; 0 unswept/);
 assert.ok((await requests(s.home)).slice(before).every(row => row.path === '/oauth/tokens' || row.path === '/api/v2/oauth/tokens/current' || row.path.includes('/incremental/tickets/')));
 assert.equal((await census(join(s.path,'probe'))).unswept, 0);
 s.task('retire', { mode: 'retire' }); const retired = await s.run(); assert.match(retired.stdout + retired.stderr, /VENDOR_REVOKED/);
 await assert.rejects(stat(s.path), { code: 'ENOENT' });
 assert.ok(!Object.hasOwn(JSON.parse(await readFile(join(s.home,'fake-keychain.json'),'utf8')), 'vendor:zendesk:read'));
 s.task('refused-after-retire'); const refused = await s.run(); assert.match(refused.stderr, /VENDOR_REVOKED/);
 t.diagnostic('PROBE P8: package-required snapshot retained without partial upload; package plan not exercised');
});

test('P7: Guide unavailable coverage and source-locale records are explicit', async t => {
 for (const scenario of ['guide-404','source-locale']) {
  const s = await setup(t, scenario), output = await s.run({ scenario });
  assert.equal(output.code, 0, output.stderr);
  const exported = await result(s.path);
  if (scenario === 'guide-404') { assert.equal(exported.census.guide.available, false); assert.equal(exported.census.guide.articles, 0); }
  else {
   const article = exported.bytes.toString().trim().split('\n').map(JSON.parse).find(row => row.article).article;
   assert.equal(article.locale, 'en-us'); assert.equal(article.title, 'Restricted draft');
   assert.ok((await requests(s.home)).some(row => row.path === '/api/v2/help_center/en-us/articles/8'));
  }
 }
});
