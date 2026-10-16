// The published rer, end to end through its public doors: build the tarball,
// install it with npx into a scratch HOME, and launch the default-seed
// reference in package mode (exported, then converted by the export tool to
// pin that tarball's version, served from a local registry) with one `rer
// dev`; open its sign-in link in a browser and stop it. Before any install,
// `rer check` installs the pin and passes. The export's setup
// manifest gains required fields that only their localDefault can fill:
// without one the launch stops naming the field and changes nothing. A fresh
// copy of the converted checkout then builds as the trusted delivery job runs
// it: pnpm install --frozen-lockfile && pnpm run build, with no rer on PATH.
// Before that, the real owner's rer setup replaces the zero-setup owner and
// keeps the local data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { access, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageReference } from '../../scripts/rer-package/reference.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { freePort, run, sweep } from './harness.mjs';
import { requireSavedOwnerInput } from './resume-owner.mjs';

const base = resolve(import.meta.dirname, '../..');
const { chromium } = createRequire(join(base, 'default-seed/package.json'))('@playwright/test');

// The checkout's local database: its active owners and every table's row count.
function localData(root) {
 const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'), owners = [], counts = {};
 for (const file of readdirSync(directory).filter(name => name.endsWith('.sqlite'))) {
  const db = new DatabaseSync(join(directory, file), { readOnly: true });
  try {
   for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()) counts[`${file}:${name}`] = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count;
   if (counts[`${file}:oa_operators`] !== undefined) owners.push(...db.prepare("SELECT id, email FROM oa_operators WHERE role='owner' AND status='active'").all().map(row => ({ ...row })));
  } finally { db.close(); }
 }
 return { owners, counts };
}

test('an installed rer launches the package-mode default-seed reference with one command, and it builds without rer', { timeout: 15 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-journey-')), home = join(directory, 'home'), root = join(directory, 'seed with spaces'), delivery = join(directory, 'delivery');
 let stop, registry;
 // A journey that fails partway still stops its server, and fails if the stop
 // left anything of the checkout running (which is then ended by PID).
 t.after(async () => {
  try {
   const stopped = await stop?.(), left = await sweep(root);
   assert.deepEqual(left.map(item => item.command), [], `rer dev --stop (exit ${stopped?.code}: ${stopped?.stderr}) left these running`);
  } finally { await registry?.close(); await rm(directory, { recursive: true, force: true }); }
 });

 const built = await run(process.execPath, ['scripts/rer-package.mjs', '--out', join(directory, 'package')], { cwd: base, env: process.env });
 assert.equal(built.code, 0, built.stderr);
 const tarball = built.stdout.trim().split('\n').pop();

 // npx from the tarball, with an empty npm config and no registry to reach.
 await writeFile(join(directory, 'npmrc'), '');
 const installed = await run('npx', ['-y', `--package=${tarball}`, 'rer', 'cli', 'install'], { cwd: directory, env: {
  PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'), npm_config_cache: join(directory, 'npm-cache'), npm_config_registry: 'http://127.0.0.1:9/',
 } });
 assert.equal(installed.code, 0, installed.stderr);
 const rer = join(home, '.local/bin/rer');
 await access(rer);

 const queued = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_SERVERS_DIR: join(directory, 'servers'), ...Object.fromEntries(['TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'COREPACK_HOME', 'npm_config_store_dir'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
 const reference = await packageReference(base, root, tarball, { directory, env: queued });
 ({ registry } = reference);
 const { env } = reference;
 const pinned = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@runeditrun/rer'];
 assert.equal(pinned, reference.version, 'the conversion pins the latest version the registry holds, exactly');
 for (const path of ['scripts/rer.mjs', 'scripts/base-cli', 'scripts/base-onboarding']) await assert.rejects(access(join(root, path)), `${path} is removed`);
 await cp(root, delivery, { recursive: true });
 const manifestPath = join(root, 'rer-setup.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
 const password = { name: 'OWNER_PASSWORD', label: 'Owner password', kind: 'secret', input: 'entered', ownerVisible: true, required: true };
 manifest.fields.push(
  { name: 'WORKSPACE_NAME', label: 'Workspace name', kind: 'text', required: true, localDefault: 'Review workspace' },
  { name: 'WIDGET_ORIGIN', label: 'Widget origin', kind: 'url', required: true, localDefault: { from: 'origin' } },
  password,
 );
 await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
 const port = await freePort(), url = `http://127.0.0.1:${port}`;
 stop = () => run(rer, ['dev', '--stop'], { cwd: root, env });

 const version = (await run(rer, ['--version'], { cwd: root, env })).stdout.trim().split('\n');
 assert.ok(version[1].includes(` ${version[0]} `), `the export pins the version of the package built from the same commit: ${version.join(' / ')}`);
 // Until node_modules holds the pinned package, every verb installs it with the
 // frozen lockfile first: check runs with the pinned bytes, so a fresh clone
 // checks before any install of its own.
 await assert.rejects(access(join(root, 'node_modules/@runeditrun/rer')), 'nothing is installed yet');
 const checked = await run(rer, ['check', '--profile', 'first-party', '--json'], { cwd: root, env });
 const report = JSON.parse(checked.stdout.trim().split('\n').at(-1));
 assert.equal(checked.code, 0, 'the converted reference passes check in package mode: ' + JSON.stringify(report.clauses?.filter(clause => !clause.ok)) + checked.stderr.slice(-2000));
 assert.ok(report.clauses.some(clause => clause.id === 'SC-13.package.lockfile' && clause.ok), 'check ran the pinned package');
 const prepared = async () => JSON.parse((await run(rer, ['describe', '--json'], { cwd: root, env })).stdout).local.prepared;

 // Turn the real exported app into a local bare remote. The public repository
 // form must clone it from outside a checkout, then reuse that clone on resume.
 const remote = join(directory, 'reference.git'), repo = pathToFileURL(remote).href;
 for (const args of [['init'], ['add', '--', '.', ':!node_modules'], ['-c', 'user.name=Journey', '-c', 'user.email=journey@example.test', 'commit', '-m', 'Reference fixture']]) {
  const result = await run('git', args, { cwd: root, env });
  assert.equal(result.code, 0, result.stderr);
 }
 const bare = await run('git', ['clone', '--bare', root, remote], { cwd: directory, env });
 assert.equal(bare.code, 0, bare.stderr);
 await rm(root, { recursive: true, force: true });
 const fromRepo = args => run(rer, ['dev', repo, '--dir', root, ...args], { cwd: directory, env });

 // A required field with no value and no localDefault: exit 3 naming it, and
 // no settings, owner, dev key or server.
 const stopped3 = await fromRepo(['--port', String(port)]);
 assert.equal(stopped3.code, 3, stopped3.stderr + stopped3.stdout);
 assert.match(stopped3.stderr, /OWNER_PASSWORD/);
 for (const path of ['.dev.vars', '.seed/installer/setup-answers.json', '.rer/local/dev-key.env', '.wrangler/state']) await assert.rejects(access(join(root, path)), `${path} is not written`);
 await assert.rejects(fetch(url + '/health'), 'no server was started');
 // The checkout is still not set up.
 assert.equal(await prepared(), false);

 password.localDefault = { generate: 'hex' };
 await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
 await requireSavedOwnerInput(root);
 const interrupted = await fromRepo(['--port', String(port)]);
 assert.equal(interrupted.code, 1, 'the first setup fails before claiming the owner');
 await access(join(root, 'owner-hook-reached')).catch(error => { t.diagnostic(interrupted.stderr); throw error; });
 const retained = await readFile(join(root, '.dev.vars'), 'utf8');
 assert.ok(parseEnv(retained).OWNER_PASSWORD, 'failed setup saved its generated owner password');
 assert.deepEqual(localData(root).owners, [], 'failed setup has not claimed an owner');
 await rm(join(root, 'fail-before-owner'));
 // Not a terminal: the one command prepares, starts, prints and returns.
 const launched = await fromRepo(['--port', String(port)]);
 assert.equal(launched.code, 0, 'rer dev resumes the saved owner claim: ' + launched.stderr + launched.stdout);
 assert.ok(retained === await readFile(join(root, '.dev.vars'), 'utf8'), 'resume preserves every private setting byte');
 assert.deepEqual(localData(root).owners.map(owner => owner.email), [parseEnv(retained).OWNER_EMAIL], 'resume claims the saved owner');
 assert.equal(await prepared(), true);
 assert.equal((await stat(join(root, '.dev.vars'))).mode & 0o777, 0o600);
 const settings = parseEnv(await readFile(join(root, '.dev.vars'), 'utf8'));
 assert.equal(settings.WORKSPACE_NAME, 'Review workspace');
 assert.equal(settings.WIDGET_ORIGIN, url, 'the origin local default is the chosen local origin');
 assert.match(settings.OWNER_PASSWORD, /^[0-9a-f]{64}$/);
 const serverLog = launched.stdout.match(/^Server log \(private\): (.+)$/m)[1];
 for (const text of [interrupted.stdout, interrupted.stderr, launched.stdout, launched.stderr, await readFile(serverLog, 'utf8'), await readFile(join(serverLog, '../launch.log'), 'utf8')]) assert.ok(!text.includes(settings.OWNER_PASSWORD), 'the generated value is never printed or logged');
 const lines = Object.fromEntries(launched.stdout.split('\n').filter(line => /^RER_[A-Z_]+ /.test(line)).map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));
 assert.equal(lines.RER_READY, url);
 assert.equal(lines.RER_SIGNED_IN, 'owner@seed-with-spaces.test');
 assert.equal((await fetch(url + '/health')).status, 200, 'the server keeps running after rer dev returns');
 // The seed's run site: RER_SITE serves its static homepage and /run, and a repeated rer dev names it again.
 assert.match(lines.RER_SITE, /^http:\/\/127\.0\.0\.1:\d+$/);
 for (const path of ['/', '/run']) assert.equal((await fetch(lines.RER_SITE + path)).status, 200, `run site preview ${path}`);
 const repeated = await run(rer, ['dev'], { cwd: root, env });
 assert.equal(repeated.code, 0, repeated.stderr + repeated.stdout);
 assert.ok(repeated.stdout.split('\n').includes(`RER_SITE ${lines.RER_SITE}`), 'a repeated rer dev reprints RER_SITE');

 const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
 try {
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(lines.RER_OPEN);
  await page.waitForURL(url + '/setup');
  const session = await (await context.request.get(url + '/auth/session')).json();
  assert.equal(session.operator.email, 'owner@seed-with-spaces.test', 'RER_OPEN signs the browser in as the generated owner');
 } finally { await browser.close(); }

 const stopped = await run(rer, ['dev', '--stop'], { cwd: root, env });
 assert.equal(stopped.code, 0, stopped.stderr);
 await assert.rejects(fetch(url + '/health'), 'rer dev --stop frees the port');
 await assert.rejects(fetch(lines.RER_SITE), 'rer dev --stop frees the run site preview port');

 // The real owner's setup replaces the zero-setup owner in place: the same
 // account under the real address, every local row kept, and rer dev then signs
 // in as the real owner.
 const before = localData(root), real = 'real-owner@example.com';
 const replaced = await run(rer, ['setup', '--owner-email', real, '--non-interactive'], { cwd: root, env });
 assert.equal(replaced.code, 0, replaced.stderr + replaced.stdout);
 assert.ok(settings.OWNER_PASSWORD === parseEnv(await readFile(join(root, '.dev.vars'), 'utf8')).OWNER_PASSWORD, 'explicit setup passes the same saved password to the owner hook');
 assert.equal(replaced.stdout.split('\n').filter(line => line.includes('owner@seed-with-spaces.test') && line.includes(real)).length, 1, 'one line says the zero-setup owner was replaced');
 const after = localData(root);
 assert.deepEqual(after.owners, [{ id: before.owners[0].id, email: real }], 'the zero-setup owner row now holds the real address');
 for (const [table, count] of Object.entries(before.counts)) assert.ok(after.counts[table] >= count, `${table} keeps its ${count} rows`);
 const relaunched = await run(rer, ['dev', '--port', String(port)], { cwd: root, env });
 assert.equal(relaunched.code, 0, relaunched.stderr + relaunched.stdout);
 assert.ok(relaunched.stdout.split('\n').includes(`RER_SIGNED_IN ${real}`), relaunched.stdout);
 assert.equal((await run(rer, ['dev', '--stop'], { cwd: root, env })).code, 0);

 // The trusted delivery job: a fresh copy, the frozen lockfile and the
 // package's own rer from node_modules/.bin, with no rer on PATH.
 const path = process.env.PATH.split(delimiter).filter(entry => { try { return !statSync(join(entry, 'rer')).isFile(); } catch { return true; } }).join(delimiter);
 const deliveryEnv = { ...env, PATH: path };
 assert.notEqual((await run('sh', ['-c', 'command -v rer'], { cwd: delivery, env: deliveryEnv })).code, 0, 'no rer on PATH');
 const frozen = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: delivery, env: deliveryEnv });
 assert.equal(frozen.code, 0, frozen.stdout + frozen.stderr);
 const delivered = await run('pnpm', ['run', 'build'], { cwd: delivery, env: deliveryEnv });
 assert.equal(delivered.code, 0, delivered.stdout.slice(-3000) + delivered.stderr.slice(-3000));
 await access(join(delivery, 'dist/server/wrangler.json'));
});
