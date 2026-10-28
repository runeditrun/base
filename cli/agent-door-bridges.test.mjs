import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { writeFile, symlink } from 'node:fs/promises';
import { bridgeSeed, document } from './tests/fixtures/agent-door/bridge-seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');
async function verify(t, root, ok = true) {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 const execution = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 }).then(value => ({ ...value, exit: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, exit: error.code }));
 const events = execution.stdout.trim().split('\n').map(JSON.parse), result = { ...events.at(-1), ...events.find(event => event.event === 'error') };
 const points = result.agentDoor?.points ?? [...execution.stderr.matchAll(/^(PASS|FAIL) (\S+?)(?:: (.*))?$/gm)].map(([, outcome, id, detail]) => ({ id, ok: outcome === 'PASS', detail }));
 const failures = points.filter(point => !point.ok).map(point => `${point.id}: ${point.detail}`);
 assert.equal(execution.exit === 0, ok, JSON.stringify({ code: result.code, message: result.message, failures, stderr: execution.stderr.split('\n').filter(line => !/^(PASS|FAIL) /.test(line)).join('\n') }));
 if (ok) assert.equal(result.agentDoor?.ok, true);
 t.diagnostic(`rer verify: exit=${execution.exit}; ${points.filter(point => point.ok).length}/${points.length} points passed${result.code ? `; ${result.code}` : ''}.`);
 return { points, result, output: execution.stdout + execution.stderr };
}

test('public door drains the native queue and rechecks originating consent at worker execution', { timeout: 120000 }, async t => {
 const root = await bridgeSeed(t, 'queued');
 const { points } = await verify(t, root);
 for (const id of ['invocation-effect', 'invocation-revoked', 'invocation-no-effect', 'invocation-audit.done', 'invocation-audit.refused']) assert.ok(points.some(point => point.id === `BASE-AGENT-012.${id}` && point.ok), id);
 t.diagnostic('Queued bridge: native queue effect PASS; saved consent revoked PASS; no second effect and both audits PASS.');
 await writeFile(join(root, 'broken-invoke.mjs'), 'export default () => { throw new Error("private verifier context"); };');
 await document(root, 'agent-surface.json', surface => { surface.verification.invoke.module = 'broken-invoke.mjs'; });
 const negative = await verify(t, root, false);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-012.invocation' && !point.ok));
 assert.doesNotMatch(negative.output, /private verifier context/);
 t.diagnostic('Queued negative: broken native driver FAIL with redacted diagnostic.');
});

test('public door drives an isolated RPC egress verifier and retains native signature checks', { timeout: 120000 }, async t => {
 const root = await bridgeSeed(t, 'rpc');
 const { points } = await verify(t, root);
 assert.ok(points.some(point => point.id === 'BASE-AGENT-013.4.held.dispatch' && point.ok));
 t.diagnostic('RPC bridge: native signed RPC delivery, held approval and isolated network denial PASS.');
 await writeFile(join(root, 'bad-rpc.mjs'), "import { WorkerEntrypoint } from 'cloudflare:workers'; export class Delivery extends WorkerEntrypoint { send(){ return { status:202, body:{} }; } }");
 await document(root, 'agent-surface.json', surface => { surface.verification.rpc.FIXTURE_EGRESS.module = 'bad-rpc.mjs'; });
 const negative = await verify(t, root, false);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-013.4.autonomous.dispatch' && !point.ok));
 t.diagnostic('RPC negative: unsigned RPC receipt FAIL through native validation.');
 await symlink(join(base, 'cli/agent-network.mjs'), join(root, 'escape-rpc.mjs'));
 await document(root, 'agent-surface.json', surface => { surface.verification.rpc.FIXTURE_EGRESS.module = 'escape-rpc.mjs'; });
 const escaped = await verify(t, root, false);
 assert.equal(escaped.result.code, 'agent_rpc_invalid');
});

test('public door generates a valid GitHub JSON and PEM owner binding for a signed claim', { timeout: 120000 }, async t => {
 const root = await bridgeSeed(t, 'github');
 const { points, output } = await verify(t, root);
 assert.ok(points.some(point => point.id === 'BASE-AGENT-013.4.autonomous.github' && point.ok));
 assert.doesNotMatch(output, /BEGIN PRIVATE KEY|operator_session=|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
 t.diagnostic('GitHub binding: runtime RSA PKCS8 JSON, signed owner claim and native App JWT sign/verify PASS.');
 await writeFile(join(root, 'bad-binding.mjs'), 'export default () => JSON.stringify({ appId:"42",installationId:"7",privateKey:"invalid" });');
 await document(root, 'agent-surface.json', surface => { surface.verification.owner.bindings.GITHUB_CONNECTION.module = 'bad-binding.mjs'; });
 const negative = await verify(t, root, false);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-013.4.autonomous.github' && !point.ok));
 t.diagnostic('GitHub negative: invalid native PEM binding FAIL.');
});

test('public door runs native lifecycle hooks between mandatory autonomous and held journey steps', { timeout: 120000 }, async t => {
 const root = await bridgeSeed(t, 'lifecycle');
 const { points } = await verify(t, root);
 for (const phase of ['autonomous', 'held']) assert.ok(points.some(point => point.id === `BASE-AGENT-013.4.${phase}.send-json` && point.ok));
 t.diagnostic('Lifecycle bridge: native repository consent between create and send PASS in autonomous and held phases.');
 await document(root, 'agent-surface.json', surface => { surface.verification.journey = 'journey.mjs'; });
 const negative = await verify(t, root, false);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-013.4.autonomous.send-json' && !point.ok));
 t.diagnostic('Lifecycle negative: missing native consent hook FAIL.');
});

test('public door accepts composite narrowing targets and rejects widening or mismatched tuples', { timeout: 180000 }, async t => {
 const root = await bridgeSeed(t, 'composite');
 const { points } = await verify(t, root);
 for (const check of ['target', 'subset', 'undeclared']) assert.ok(points.some(point => point.id === `BASE-AGENT-005.narrowing.fixture.members.revoke.${check}` && point.ok));
 t.diagnostic('Composite narrowing: exact team/member tuple, strict grant reduction, unchanged neighbors and widening refusal PASS.');
 await document(root, 'agent-surface.json', surface => { surface.narrowings.at(-1).witness.args.operator_id = 'another-member'; });
 const mismatch = await verify(t, root, false);
 assert.ok(mismatch.points.some(point => point.id === 'BASE-AGENT-005.narrowing.fixture.members.revoke.target' && !point.ok));
 t.diagnostic('Composite negative: mismatched second target key FAIL.');
 await document(root, 'agent-surface.json', surface => { surface.tools.find(tool => tool.name === 'fixture.members.revoke').inputSchema.properties.role = { type: 'string' }; });
 const widening = await verify(t, root, false);
 assert.ok(widening.points.some(point => point.id === 'BASE-AGENT-005.surface.fixture.members.revoke.narrowing-contract' && !point.ok));
 t.diagnostic('Composite negative: declared widening field FAIL.');
});
