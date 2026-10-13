import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readOperations, resolveCommand, deployDescriptor } from './operations.mjs';
import { qualifyStandalone } from '../qualify-standalone.mjs';
import { hostedOrigin, healthAndWidget } from './http.mjs';

const tempRoot = process.env.T016_TEST_TMP;
function fixture(t, version = 2) {
  assert.ok(tempRoot, 'set T016_TEST_TMP to the session scratch directory');
  const cwd = mkdtempSync(join(tempRoot, 'descriptor-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const descriptor = { version, project: 'independent/alternate', commands: {
    setup: { argv: [process.execPath, 'prepare.mjs', '--local'], effects: 'Use --remote to provision the hosted target.' },
    deploy: { argv: ['sh', '-c', 'node publish.mjs "$1"', 'publisher', '--local'], effects: 'Use --remote to publish the hosted target.' },
  }, health: { path: '/health' } };
  writeFileSync(join(cwd, 'OPERATIONS.json'), JSON.stringify(descriptor));
  writeFileSync(join(cwd, 'prepare.mjs'), `import fs from 'node:fs'; if(process.env.EVIDENCE_WRITE_TOKEN||process.env.OPENAI_API_KEY) process.exit(9); fs.writeFileSync('prepared',process.argv[2]);`);
  writeFileSync(join(cwd, 'publish.mjs'), `import fs from 'node:fs'; if(fs.readFileSync('prepared','utf8')!=='--remote'||process.argv[2]!=='--remote') process.exit(8); fs.writeFileSync('published',process.cwd());`);
  return { cwd, descriptor, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
}
test('alternate v1/v2 seeds execute their own actual argv and explicit shell in seed cwd', t => {
  for (const version of [1, 2]) {
    const f = fixture(t, version), observed = [];
    deployDescriptor({ ...f, remoteSelection: { from: '--local', to: '--remote' }, observe: (name, result) => observed.push([name, result.exitCode]) });
    assert.equal(readFileSync(join(f.cwd, 'published'), 'utf8'), f.cwd);
    assert.deepEqual(observed, [['setup', 0], ['deploy', 0]]);
  }
});
test('generic qualification completes an alternate seed journey after its descriptor deployment', async t => {
  const f = fixture(t), old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  globalThis.fetch = async url => url.endsWith('/health') ? Response.json({ status: 'ok' }) : new Response('window.widget = true;', { headers: { 'content-type': 'application/javascript' } });
  let ran = false;
  await qualifyStandalone({ directory: f.cwd, origin: 'https://alternate.example', env: f.env, remoteSelection: { from: '--local', to: '--remote' }, widgetPath: '/widget.js',
    journey: async ({ directory }) => { assert.equal(readFileSync(join(directory, 'published'), 'utf8'), f.cwd); ran = true; } });
  assert.equal(ran, true);
  await assert.rejects(qualifyStandalone({ directory: f.cwd, origin: 'https://alternate.example', env: f.env, remoteSelection: { from: '--local', to: '--remote' }, widgetPath: '/widget.js', journey: async () => { throw new Error('owner-claim-failed'); } }), /owner-claim-failed/);
});
test('missing/malformed/local commands fail before setup; command exit failures are preserved', t => {
  const f = fixture(t);
  for (const command of [null, {}, { argv: 'node unsafe' }, { argv: [] }, { argv: ['node', ''] }, { argv: ['node', '\0'] }]) {
    const descriptor = structuredClone(f.descriptor); descriptor.commands.deploy = command;
    assert.throws(() => resolveCommand(descriptor, 'deploy'), /invalid-command/);
  }
  assert.throws(() => resolveCommand(f.descriptor, 'deploy'), /local-target/);
  const bad = structuredClone(f.descriptor); delete bad.commands.setup.effects;
  assert.throws(() => resolveCommand(bad, 'setup', { from: '--local', to: '--remote' }), /undeclared-remote/);
  writeFileSync(join(f.cwd, 'prepare.mjs'), 'process.exit(7);');
  const results = [];
  assert.throws(() => deployDescriptor({ ...f, remoteSelection: { from: '--local', to: '--remote' }, observe: (name, result) => results.push([name, result.exitCode]) }), /setup-failed/);
  assert.deepEqual(results, [['setup', 7]]);
  writeFileSync(join(f.cwd, 'prepare.mjs'), ''); writeFileSync(join(f.cwd, 'publish.mjs'), 'process.exit(6);');
  assert.throws(() => deployDescriptor({ ...f, remoteSelection: { from: '--local', to: '--remote' } }), /deploy-failed/);
});
test('descriptor outside checkout and local origins rejected; missing journey cannot pass', async t => {
  const f = fixture(t); mkdirSync(join(f.cwd, 'nested')); symlinkSync('../OPERATIONS.json', join(f.cwd, 'nested/OPERATIONS.json'));
  assert.throws(() => readOperations(join(f.cwd, 'nested')), /descriptor-escape/);
  for (const origin of ['http://host.test', 'https://localhost', 'https://127.0.0.1', 'https://user:password@host.test', 'https://host.test/path']) assert.throws(() => hostedOrigin(origin));
  await assert.rejects(qualifyStandalone({ directory: f.cwd, origin: 'https://remote.example', env: f.env }), /journey-unconfigured/);
});
test('health and widget reject actual HTTP errors and non-JavaScript fallback pages', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  for (const [status, type] of [[503, 'application/json'], [200, 'text/html']]) {
    globalThis.fetch = async url => new Response(url.endsWith('/health') ? '{"status":"ok"}' : 'body', { status: url.endsWith('/health') ? 200 : status, headers: { 'content-type': type } });
    await assert.rejects(healthAndWidget('https://remote.example', { health: { path: '/health' } }, '/widget.js'), /widget-failed/);
  }
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(healthAndWidget('https://remote.example', { health: { path: '/health' } }, '/widget.js'), /http-status-failed/);
});
