// Smoke-test one built @runeditrun/rer tarball, the exact file a release
// publishes, in a clean HOME with an empty npm config:
//   node scripts/rer-package/smoke.mjs TARBALL [--port N]
// `npx --package=TARBALL rer cli install`, `rer --version`, then a zero-setup
// `rer dev` (ready URL and sign-in line, /health answering) and `rer dev
// --stop` on two fresh default-seed exports: one vendored, as seeds carry it
// today, and one in package mode, converted to pin this tarball's version
// served from a local registry; that one then runs `rer deploy --demo
// --dry-run`, the hosted demo every exported seed can build. Exits non-zero on
// any failure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportReference } from '../export-reference.mjs';
import { packageReference } from './reference.mjs';
import { readPackage } from '../../global/update/archive.mjs';

const base = resolve(import.meta.dirname, '../..');

function run(program, args, options) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  // Echoed for the log with any sign-in link's key fragment left out.
  child.stdout.on('data', data => { stdout += data; process.stdout.write(String(data).replace(/(RER_OPEN \S+?)#\S+/g, '$1#(key withheld)')); });
  child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

async function freePort() {
 const server = createServer();
 await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
 const { port } = server.address();
 await new Promise(resolveClose => server.close(resolveClose));
 return port;
}

export async function smoke(tarball, { port } = {}) {
 const bytes = await readFile(tarball);
 const files = readPackage(bytes, { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
 const { version } = JSON.parse(files.find(file => file.path === 'package.json').data);
 const directory = await mkdtemp(join(tmpdir(), 'rer-smoke-')), home = join(directory, 'home');
 // A clean HOME and an empty npm config; tools come from PATH only.
 for (const name of ['npmrc', 'global-npmrc']) await writeFile(join(directory, name), '');
 const env = {
  // The caller's own resource thresholds and package store, when it sets them.
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^RER_(JOBS|SERVERS)_.*(THRESHOLD|BYTES)$/.test(name) || name === 'npm_config_store_dir')),
  PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', TMPDIR: process.env.TMPDIR ?? tmpdir(), CI: 'true', WRANGLER_SEND_METRICS: 'false',
  NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(directory, 'global-npmrc'), npm_config_cache: join(directory, 'npm-cache'),
  RER_SERVERS_DIR: join(directory, 'servers'), RER_JOBS_DIR: join(directory, 'jobs'), RER_NO_UPDATE_CHECK: '1',
 };
 const rer = join(home, '.local/bin/rer');
 const started = new Map();
 let registry;
 // One zero-setup launch and stop of a checkout.
 async function launch(root, launchEnv, mode) {
  const chosen = port ?? await freePort(), url = `http://127.0.0.1:${chosen}`;
  started.set(root, launchEnv);
  const launched = await run(rer, ['dev', '--port', String(chosen)], { cwd: root, env: launchEnv });
  assert.equal(launched.code, 0, `zero-setup rer dev (${mode})`);
  const lines = Object.fromEntries(launched.stdout.split('\n').filter(line => /^RER_[A-Z_]+ /.test(line)).map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));
  assert.equal(lines.RER_READY, url, `rer dev prints the ready URL (${mode})`);
  assert.ok(lines.RER_OPEN || lines.RER_SIGN_IN, `rer dev prints a sign-in line (${mode})`);
  assert.equal((await fetch(url + '/health')).status, 200, `the app answers after rer dev returns (${mode})`);
  const stopped = await run(rer, ['dev', '--stop'], { cwd: root, env: launchEnv });
  started.delete(root);
  assert.equal(stopped.code, 0, `rer dev --stop (${mode})`);
  await assert.rejects(fetch(url + '/health'), `rer dev --stop frees the port (${mode})`);
  return url;
 }
 try {
  const installed = await run('npx', ['-y', `--package=${resolve(tarball)}`, 'rer', 'cli', 'install'], { cwd: directory, env });
  assert.equal(installed.code, 0, 'npx --package=TARBALL rer cli install');
  const printed = await run(rer, ['--version'], { cwd: directory, env });
  assert.equal(printed.code, 0, 'rer --version');
  assert.equal(printed.stdout.trim(), version, 'rer --version prints the tarball version');

  const vendored = join(directory, 'default-seed');
  await exportReference(base, vendored);
  const url = await launch(vendored, env, 'vendored');

  const packaged = join(directory, 'default-seed-package');
  const reference = await packageReference(base, packaged, tarball, { directory, env });
  registry = reference.registry;
  process.stdout.write(reference.transcript);
  assert.equal(JSON.parse(await readFile(join(packaged, 'package.json'), 'utf8')).devDependencies['@runeditrun/rer'], version, 'the package-mode reference pins this tarball');
  await launch(packaged, reference.env, 'package mode');
  // The exported seed carries the demo module in src/, where the container
  // import boundary checks it.
  const demo = await run(rer, ['deploy', '--demo', '--dry-run'], { cwd: packaged, env: reference.env });
  assert.equal(demo.code, 0, 'rer deploy --demo --dry-run (package mode)');
  assert.ok(JSON.parse(await readFile(join(packaged, '.rer/demo-host/wrangler.json'), 'utf8')).containers?.length, 'the dry run writes the demo Worker with its container');
  return { version, url };
 } finally {
  for (const [root, launchEnv] of started) await run(rer, ['dev', '--stop'], { cwd: root, env: launchEnv }).catch(() => {});
  await registry?.close();
  await rm(directory, { recursive: true, force: true });
 }
}

if (process.argv[1] === import.meta.filename) {
 const [tarball, flag, value] = process.argv.slice(2);
 if (!tarball || (flag && (flag !== '--port' || !/^\d+$/.test(value ?? '')))) { process.stderr.write('Usage: node scripts/rer-package/smoke.mjs TARBALL [--port N]\n'); process.exit(2); }
 const result = await smoke(tarball, { port: flag ? Number(value) : undefined });
 process.stdout.write(`SMOKE_OK ${result.version} ${result.url}\n`);
}
