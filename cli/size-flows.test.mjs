import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedQueue } from './fixtures/queue.mjs';
import { declaration, writeSizeSeed } from './fixtures/size-flows-seed.mjs';

const run = promisify(execFile), rer = resolve(import.meta.dirname, '../bin/rer.mjs');
const exec = (args, env) => run(process.execPath, [rer, ...args], { env }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
const result = ({ stdout }) => stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.event === 'result');

// Every test that reads the flows of the full seed shares one run of `rer size`: a seed whose routes each read
// `items` in a way the check should judge (see fixtures/size-flows-seed.mjs).
const directories = [];
after(() => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));
async function seeded(shape) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-size-flows-'));
 directories.push(directory);
 return { directory, root: await writeSizeSeed(directory, shape) };
}
async function sizeRun(t, shape, extra = []) {
 const { directory, root } = await seeded(shape), env = await isolatedQueue(t, process.env);
 const outcome = await exec(['size', '--cwd', root, '--json', ...extra.map(item => item.replace('{dir}', directory))], env);
 return { directory, outcome, size: result(outcome) };
}
let full;
const fullRun = t => full ??= sizeRun(t, declaration, ['--write-statements', '{dir}/statements']);
const flow = (size, name) => size.flows.find(item => item.name === name);

test('rer size meters each declared flow at both sizes and fails growth, a ceiling, a refused statement and a deep one', { timeout: 300_000 }, async t => {
 const { outcome, size } = await fullRun(t);
 assert.equal(outcome.code, 1, outcome.stdout + outcome.stderr);
 assert.equal(size.ok, false);
 const rules = name => flow(size, name).failures.map(failure => failure.rule);
 assert.deepEqual(rules('scan'), ['growth'], 'an unindexed scan reads more at large than at small');
 assert.deepEqual(rules('keyed'), [], 'a keyed read passes');
 assert.deepEqual(rules('heavy'), ['ceiling'], 'a read that is the same at both sizes but over its ceiling fails the ceiling alone');
 assert.ok(rules('deep').includes('refused'), 'local D1 refuses 13 nested EXISTS, and the flow fails naming the refusal');
 assert.ok(flow(size, 'deep').failures.find(failure => failure.rule === 'refused').sql.includes('EXISTS'));
 assert.ok(rules('deep').includes('statement-size'), 'the same statement is over the depth margin');
 assert.equal(size.queueConsumersMeasured, false);
});

test('rows are counted wherever the app reads: first, raw, batch, a session, waitUntil work, a Durable Object, its WebSocket and the scheduled handler', { timeout: 300_000 }, async t => {
 const { size } = await fullRun(t);
 for (const name of ['scan', 'raw-scan', 'batch-scan', 'session-scan', 'later', 'counter', 'socket', 'tick']) {
  const item = flow(size, name);
  assert.ok(item.large.rowsRead > item.small.rowsRead, `${name} is counted: it reads more at large than at small`);
  assert.ok(item.failures.some(failure => failure.rule === 'growth'), `${name} fails growth`);
 }
 assert.equal(flow(size, 'socket').kind, 'websocket');
 assert.equal(flow(size, 'tick').kind, 'scheduled');
 assert.equal(flow(size, 'later').large.status, 202, 'the response did not wait for the waitUntil scan that was counted');
});

test('a signin persona captures a token, keeps its cookie and header, and a later flow uses the token in its path', { timeout: 300_000 }, async t => {
 const { size } = await fullRun(t);
 const me = flow(size, 'me');
 assert.equal(me.large.status, 200);
 assert.deepEqual(me.failures, []);
});

test('--write-statements writes each size in the fleet runner\'s format with the parameters as bound', { timeout: 300_000 }, async t => {
 const { directory } = await fullRun(t);
 for (const size of ['small', 'large']) {
  const { statements } = JSON.parse(await readFile(join(directory, 'statements', `${size}.json`), 'utf8'));
  const scan = statements.find(statement => statement.name === 'scan #1');
  assert.ok(scan.sql.includes('FROM items WHERE note = ?'));
  assert.deepEqual(scan.params, ['x']);
 }
});

test('a persona that cannot sign in fails the run, naming the persona, the request and the status', { timeout: 300_000 }, async t => {
 const shape = structuredClone(declaration);
 shape.personas.visitor.requests[0].path = '/nowhere';
 const { outcome, size } = await sizeRun(t, shape);
 assert.equal(outcome.code, 1);
 assert.equal(size.size.small.code, 'size_persona_failed');
 assert.match(size.size.small.error, /visitor/);
 assert.match(size.size.small.error, /requests\[0\]/);
 assert.match(size.size.small.error, /404/);
 assert.equal(size.flows, undefined, 'no flow is judged when a persona is not signed in');
});

test('flows that read the same at both sizes under their ceilings pass, and rer size exits 0', { timeout: 300_000 }, async t => {
 const shape = structuredClone(declaration);
 shape.flows = shape.flows.filter(item => ['keyed', 'me'].includes(item.name));
 const { outcome, size } = await sizeRun(t, shape);
 assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
 assert.equal(size.ok, true);
 assert.deepEqual(size.flows.map(item => item.ok), [true, true]);
});


test('rer size uses a verification-only owner and public host without changing setup', { timeout: 300_000 }, async t => {
 const shape = structuredClone(declaration);
 shape.personas = { owner: { kind: 'owner' }, anonymous: { kind: 'anonymous' } };
 shape.flows = [
  { name: 'owner', persona: 'owner', request: { method: 'GET', path: '/owner' }, ceiling: 100 },
  { name: 'public', persona: 'anonymous', request: { method: 'GET', path: '//status.rer-hosted-check.invalid/public' }, ceiling: 100 },
 ];
 const { root } = await seeded(shape), env = await isolatedQueue(t, process.env);
 const setup = JSON.stringify({ fields: [], steps: [] });
 await writeFile(join(root, 'rer-setup.json'), setup);
 await writeFile(join(root, 'agent-surface.json'), JSON.stringify({ verification: {
  owner: { email: 'synthetic-base-1@example.test', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }, publicHosts: ['STATUS_HOST'],
 } }));
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, vars: { STATUS_HOST: 'status.rer-hosted-check.invalid' } }));
 // Keep the fixture's real bootstrap; these routes require its native owner row/session and the admitted host.
 await writeFile(join(root, 'dist/server/host-entry.mjs'), `import worker, { Counter } from './index.js';
 export { Counter };
 export default {...worker, async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/owner') {
   const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind('owner').first();
   return new Response(null, {status: request.headers.get('cookie') === 'session=owner' && row?.email === 'synthetic-base-1@example.test' ? 200 : 401});
  }
  if (url.pathname === '/public') return new Response(null, {status: url.hostname === env.STATUS_HOST && request.headers.get('host') === env.STATUS_HOST ? 200 : 421});
  return worker.fetch(request, env, ctx);
 }};`);
 const file = join(root, 'dist/server/wrangler.json'), config = JSON.parse(await readFile(file, 'utf8'));
 config.main = 'host-entry.mjs';
 await writeFile(file, JSON.stringify(config));
 const outcome = await exec(['size', '--cwd', root, '--json'], env), size = result(outcome);
 assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
 assert.equal(size.ok, true);
 for (const item of size.flows) {
  assert.equal(item.small.status, 200);
  assert.equal(item.large.status, 200);
 }
 assert.equal(await readFile(join(root, 'rer-setup.json'), 'utf8'), setup, 'size must leave the actual setup flow unchanged');
 const surface = JSON.parse(await readFile(join(root, 'agent-surface.json'), 'utf8'));
 delete surface.verification.publicHosts;
 await writeFile(join(root, 'agent-surface.json'), JSON.stringify(surface));
 const refused = await exec(['size', '--cwd', root, '--json'], env);
 assert.equal(refused.code, 1, refused.stdout + refused.stderr);
 assert.equal(flow(result(refused), 'public').ok, false, 'deployment vars alone must not admit the host');
});
