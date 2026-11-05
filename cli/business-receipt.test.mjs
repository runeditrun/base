import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { verifiedFixture, digest } from '../modules/import-kit/tests/status/fixtures.ts';
import { signImporterVerificationReceipt, verifyImporterVerificationReceipt } from '../modules/import-kit/src/receipt/index.ts';

const base = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const members = ['product', 'candidate', 'mapping', 'command', 'runs', 'reconciliation', 'unmapped', 'research', 'review'];
const refused = 'Receipt signing refused; check manifest, evidence, key and output.\n';

async function fixture(t) {
 const directory = await mkdtemp(join(tmpdir(), 'business-receipt-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const credentials = new Map(), calls = [];
 let fail = false;
 // An in-memory OS credential fixture, reached only by a stand-in OS process.
 // No private material is persisted by the fixture or passed in process argv.
 const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const call = JSON.parse(Buffer.concat(chunks).toString()); calls.push(call);
  const { command, args, input } = call;
  const mac = command === '/usr/bin/security';
  let result = { code: 0, stdout: '', stderr: '' };
  if (fail) result = { code: 1, stdout: 'test-private-diagnostic', stderr: 'test-private-diagnostic' };
  else if (mac && args[0] === '-q') {
   const match = /-a (\S+) -X ([a-f0-9]+)\n$/.exec(input);
   assert.ok(match); credentials.set(match[1], Buffer.from(match[2], 'hex').toString());
  } else {
   assert.ok(mac || command === 'secret-tool');
   const handle = args[args.indexOf(mac ? '-a' : 'handle') + 1];
   if (args[0] === 'store') credentials.set(handle, input);
   else if (credentials.has(handle)) result.stdout = credentials.get(handle) + '\n';
   else result.code = mac ? 44 : 1;
  }
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
 });
 await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
 t.after(() => { server.closeAllConnections(); return new Promise(resolveClose => server.close(resolveClose)); });
 const edge = join(directory, 'os-process.mjs'), preload = join(directory, 'register.mjs');
 await writeFile(edge, `
import { spawn as realSpawn } from 'node:child_process';
export function spawn(command, args, options) {
 return realSpawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
let input = ''; for await (const chunk of process.stdin) input += chunk;
const result = await (await fetch(process.env.TEST_RECEIPT_STORE, {
 method: 'POST', body: JSON.stringify({ command: process.argv[1], args: JSON.parse(process.argv[2]), input }),
})).json();
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;
`)}, command, JSON.stringify(args)], options);
}
`);
 await writeFile(preload, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
 if (specifier === 'node:child_process' && /\\/cli\\/business\\/keychain\\.mjs$/.test(context.parentURL ?? ''))
  return { url: ${JSON.stringify(new URL('file://' + edge).href)}, shortCircuit: true };
 return nextResolve(specifier, context);
} });\n`);
 async function cli(args, entry = 'bin/rer.mjs') {
  const options = { cwd: directory, env: {
   PATH: process.env.PATH, HOME: directory, RER_NO_UPDATE_CHECK: '1',
   TEST_RECEIPT_STORE: `http://127.0.0.1:${server.address().port}`,
  }, timeout: 20000 };
  try { return { code: 0, ...await run(process.execPath, ['--import', preload, resolve(base, entry), 'business', ...args], options) }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
 }
 // Authorized-real-export metadata shape only: no vendor export or acceptance is claimed.
 const { payload } = verifiedFixture();
 const manifest = { incumbent: payload.incumbent, synthetic: false, adapter: payload.adapter, source: payload.source };
 const evidence = Object.fromEntries(members.map(member => [member, payload[member]]));
 async function inputs(m = manifest, e = evidence) {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(m));
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(e));
 }
 await inputs();
 const sign = (output = 'receipt.json', entry) => cli(['receipt', 'sign', '--manifest', 'manifest.json', '--evidence', 'evidence.json', '--key-id', 'fixture-stage', '--output', output], entry);
 return { directory, credentials, calls, cli, manifest, evidence, inputs, sign, setFailure: value => { fail = value; } };
}

test('P1 public receipt-key create stores PKCS8 only at the OS edge and prints only SPKI', async t => {
 const f = await fixture(t), before = await readdir(f.directory);
 const result = await f.cli(['receipt-key', 'create', 'fixture-stage']);
 assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
 assert.match(result.stdout, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
 const secret = f.credentials.get('receipt:fixture-stage:sign'); assert.ok(secret);
 const privateKey = createPrivateKey({ key: Buffer.from(secret, 'base64'), type: 'pkcs8', format: 'der' });
 assert.equal(privateKey.asymmetricKeyType, 'ed25519');
 assert.equal(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), result.stdout);
 assert.deepEqual(await readdir(f.directory), before);
 for (const filename of before) assert.ok(!(await readFile(join(f.directory, filename), 'utf8')).includes(secret));
 assert.ok(!result.stdout.includes(secret));
 assert.ok(f.calls.every(call => !JSON.stringify(call.args).includes(secret)));
 const duplicate = await f.cli(['receipt-key', 'create', 'fixture-stage']);
 assert.equal(duplicate.code, 1); assert.equal(duplicate.stdout, '');
 assert.equal(f.credentials.get('receipt:fixture-stage:sign'), secret);
 f.setFailure(true);
 const failure = await f.cli(['receipt-key', 'create', 'other-stage']);
 assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
 assert.equal(failure.stderr, duplicate.stderr); assert.ok(!failure.stderr.includes('test-private-diagnostic'));
 t.diagnostic('PROBE P1: rer business receipt-key create fixture-stage => 0; SPKI only, OS private key, no files; duplicate/OS failure => 1.');
});

test('P2 public signer preserves exact manifest/evidence members and stage verification in source and exported CLI', async t => {
 const f = await fixture(t);
 const created = await f.cli(['receipt-key', 'create', 'fixture-stage']); assert.equal(created.code, 0, created.stderr);
 const packed = join(f.directory, 'node_modules/@runeditrun/rer');
 const bytes = await readFile(await buildPackage(base, join(f.directory, 'tarball')));
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 for (const [index, entry] of ['bin/rer.mjs', 'default-seed/scripts/rer.mjs', join(packed, 'global/rer.mjs')].entries()) {
  const output = `receipt-${index}.json`;
  const result = await f.sign(output, entry); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Importer verification receipt written.\n'); assert.equal(result.stderr, '');
  const receipt = JSON.parse(await readFile(join(f.directory, output), 'utf8'));
  assert.deepEqual(receipt.payload, { ...f.manifest, ...f.evidence });
  const keys = { 'fixture-stage': { publicKey: created.stdout, environments: ['stage'] } };
  assert.equal((await verifyImporterVerificationReceipt(receipt, { environment: 'stage', keys })).valid, true);
  assert.equal((await verifyImporterVerificationReceipt(receipt, { environment: 'production', keys })).valid, false);
  assert.equal((await stat(join(f.directory, output))).mode & 0o777, 0o600);
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(f.credentials.get('receipt:fixture-stage:sign'), 'base64'), 'Ed25519', false, ['sign']);
  assert.deepEqual(receipt, await signImporterVerificationReceipt(receipt.payload, 'fixture-stage', privateKey));
 }
 t.diagnostic('PROBE P2: rer business receipt sign --manifest manifest.json --evidence evidence.json --key-id fixture-stage --output receipt.json => 0; exact members and canonical signature; stage valid, production refused. Metadata fixture only.');
});

test('P3 public signer refuses synthetic, schema, SHA, count, reconciliation, unmapped and unsafe metadata before writing', async t => {
 const f = await fixture(t);
 assert.equal((await f.cli(['receipt-key', 'create', 'fixture-stage'])).code, 0);
 const cases = [
  ['synthetic', m => { m.synthetic = true; }],
  ['unclassified', m => { m.source.classification = 'synthetic'; }],
  ['source SHA schema', m => { m.source.sha256 = 'wrong'; }],
  ['stream bytes', m => { m.source.size = 0; }],
  ['missing adapter', m => { delete m.adapter; }],
  ['origin', m => { m.source.origin += '?token=test-private-diagnostic'; }],
  ['missing evidence', (m, e) => { delete e.review; }],
  ['override', (m, e) => { e.source = m.source; }],
  ['nested schema', (m, e) => { e.mapping.extra = true; }],
  ['mapping SHA', (m, e) => { e.mapping.policySha256 = digest('different policy'); }],
  ['input counts', (m, e) => { e.runs.dryRun.unique++; }],
  ['empty import', (m, e) => { e.runs.dryRun.effects = 0; }],
  ['rejected rows', (m, e) => { e.runs.apply.rejected++; }],
  ['run counts', (m, e) => { e.runs.apply.mapped++; }],
  ['kind counts', (m, e) => { e.runs.apply.byKind.ticket++; }],
  ...['rows', 'provenance', 'attachments'].flatMap(kind => [
   [`${kind} SHA`, (m, e) => { e.reconciliation[kind].targetManifestSha256 = digest('different manifest'); }],
   [`${kind} count`, (m, e) => { e.reconciliation[kind].targetCount++; }],
  ]),
  ['empty SHA', (m, e) => { e.reconciliation.attachments.sourceManifestSha256 = e.reconciliation.attachments.targetManifestSha256 = digest('not empty'); }],
  ['effect counts', (m, e) => { e.reconciliation.rows.sourceCount = e.reconciliation.rows.targetCount = 3; }],
  ['unmapped SHA', (m, e) => { e.unmapped.itemManifestSha256 = digest('different items'); }],
  ['unmapped counts', (m, e) => { e.unmapped.count++; }],
  ['unsafe command', (m, e) => { e.command += ' --token test-private-diagnostic'; }],
  ['unsafe policy', (m, e) => { e.mapping.policy += ' password=test-private-diagnostic'; e.mapping.policySha256 = digest(e.mapping.policy); }],
  ['review schema', (m, e) => { e.review.result = 'pending'; }],
 ];
 for (const [name, mutate] of cases) {
  const m = structuredClone(f.manifest), e = structuredClone(f.evidence); mutate(m, e); await f.inputs(m, e);
  const result = await f.sign();
  assert.equal(result.code, 1, name); assert.equal(result.stdout, '', name); assert.equal(result.stderr, refused, name);
  await assert.rejects(readFile(join(f.directory, 'receipt.json')), { code: 'ENOENT' });
 }
 t.diagnostic(`PROBE P3: public receipt sign => 1 for all ${cases.length} invalid metadata cases; fixed stderr, empty stdout, no receipt.`);
});

test('public signer contains credential/read errors and preserves existing outputs and input aliases', async t => {
 const f = await fixture(t);
 assert.equal((await f.sign()).stderr, refused, 'missing key');
 assert.equal((await f.cli(['receipt-key', 'create', 'fixture-stage'])).code, 0);
 f.setFailure(true); assert.equal((await f.sign()).stderr, refused); f.setFailure(false);
 const saved = f.credentials.get('receipt:fixture-stage:sign');
 f.credentials.set('receipt:fixture-stage:sign', 'test-private-diagnostic');
 assert.equal((await f.sign()).stderr, refused); f.credentials.set('receipt:fixture-stage:sign', saved);
 await writeFile(join(f.directory, 'kept.json'), 'keep existing output');
 await symlink(join(f.directory, 'kept.json'), join(f.directory, 'link.json'));
 for (const output of ['kept.json', 'link.json', 'manifest.json', 'evidence.json']) {
  const before = await readFile(join(f.directory, output));
  const result = await f.sign(output); assert.equal(result.code, 1); assert.equal(result.stderr, refused);
  assert.deepEqual(await readFile(join(f.directory, output)), before);
 }
 await writeFile(join(f.directory, 'manifest.json'), '{"secret":"test-private-diagnostic"');
 assert.equal((await f.sign()).stderr, refused);
});

test('public help and usage need no credentials and reject malformed flags and key IDs', async t => {
 const f = await fixture(t);
 for (const args of [['receipt-key', '--help'], ['receipt-key', 'create', '--help'], ['receipt', '--help'], ['receipt', 'sign', '--help']]) {
  const result = await f.cli(args); assert.equal(result.code, 0); assert.match(result.stdout, /^Usage: rer business receipt/);
 }
 for (const args of [
  ['receipt-key', 'create', '../key'], ['receipt-key', 'create', 'x', 'extra'], ['receipt', 'sign'],
  ['receipt', 'sign', '--manifest', 'a', '--evidence', 'b', '--key-id', '../key', '--output', 'c'],
  ['receipt', 'sign', '--manifest', 'a', '--manifest', 'b', '--key-id', 'x', '--output', 'c'],
 ]) { const result = await f.cli(args); assert.equal(result.code, 2); assert.equal(result.stdout, ''); }
 assert.equal(f.calls.length, 0);
});
