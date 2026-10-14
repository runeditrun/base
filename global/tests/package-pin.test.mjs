// A checkout that pins the rer package, through the installed launcher: a
// fresh clone's first rer install runs dependency build scripts without the
// caller's provider credentials while the seed's own deploy still receives
// them, and after a pulled pin change rer deploy installs the new pin first.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { tarball } from '../../scripts/rer-package/tarball.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { pins, verbs } from '../../cli/contract.mjs';
import { readPackage } from '../update/archive.mjs';
import { run } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');
const launcher = join(base, 'global/rer.mjs');
// Synthetic provider credentials a person has exported in their shell.
const credentials = { CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token-0001', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', SENDGRID_API_KEY: 'SG.synthetic-sendgrid-key-0001' };

let directory, registry, versions;
before(async () => {
 directory = await mkdtemp(join(tmpdir(), 'rer-package-pin-'));
 registry = await localRegistry();
 const built = await readFile(await buildPackage(base, join(directory, 'built')));
 const entries = readPackage(built, { integrity: integrity(built) });
 const first = JSON.parse(entries.find(entry => entry.path === 'package.json').data).version, next = `${first}-next`;
 registry.publish(first, built);
 registry.publish(next, tarball(entries.map(entry => ({ path: `package/${entry.path}`, data: entry.path === 'package.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), version: next }, null, 2) + '\n') : entry.data, executable: entry.executable })), 0));
 versions = { first, next };
 await writeFile(join(directory, 'npmrc'), registry.npmrc());
});
after(async () => { await registry?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

// A seed pinning `version`, with one dependency whose install script records
// its environment, and a deploy that records the one it runs with.
async function seed(name, version) {
 const root = join(directory, name), records = join(directory, `${name}-records`);
 await mkdir(join(root, 'probe'), { recursive: true });
 await mkdir(records);
 const record = kind => `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(records)}, '${kind}-' + process.pid + '.json'), JSON.stringify(Object.keys(process.env)))`;
 await writeFile(join(root, 'probe/package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { install: 'node record.cjs' } }));
 await writeFile(join(root, 'probe/record.cjs'), record('install') + ';\n');
 await writeFile(join(root, 'adapter.mjs'), `import { createRequire } from 'node:module';
import { localInstaller } from '@runeditrun/rer/local-installer';
import { commandAdapter } from '@runeditrun/rer/adapter';
const require = createRequire(import.meta.url);
const never = ['node', ['-e', 'process.exit(9)']];
const deploy = Object.assign(async () => { ${record('deploy')}; return { deployed: true, origin: 'https://seed.example.test' }; }, { managesHostedOwner: true });
const adapter = commandAdapter(localInstaller({ build: never, migrate: never, start: never, owner: {}, signIn: {} }), { preview: never, verify: never, deploy, deployDeclaration: 'deploy.json', portability: { export: () => {}, import: () => {} }, input: { names: { email: 'email', name: 'displayName' }, validate: value => value } });
export { adapter as commandAdapter };
`);
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'example/seed', compatibilityDate: '2026-01-01' }));
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/seed', requiredEnvironment: [], runtime: { requirements: [] }, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries([...Object.keys(verbs), 'release'].map(verb => [verb, { argv: ['rer', verb], inputs: ['package.json'], effects: 'The pinned rer runs this verb.' }])) }));
 await writeFile(join(root, '.node-version'), pins.node + '\n');
 await pin(root, version);
 return { root, records };
}

// What a pulled commit changing the pin brings: package.json and its lockfile.
async function pin(root, version) {
 await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'seed', private: true, packageManager: `pnpm@${pins.pnpm}`, engines: { node: pins.node }, devDependencies: { '@runeditrun/rer': version, probe: 'file:./probe' }, pnpm: { onlyBuiltDependencies: ['probe'] } }));
 const locked = await run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: root, env: environment() });
 assert.equal(locked.code, 0, locked.stderr + locked.stdout);
}

function environment(extra = {}) {
 return { PATH: process.env.PATH, HOME: join(directory, 'home'), TMPDIR: directory, NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'), npm_config_store_dir: join(directory, 'store'), npm_config_cache: join(directory, 'cache'), RER_NO_UPDATE_CHECK: '1', WRANGLER_SEND_METRICS: 'false', ...extra };
}

async function recorded(records, kind) {
 return Promise.all((await readdir(records)).filter(name => name.startsWith(kind + '-')).map(async name => JSON.parse(await readFile(join(records, name), 'utf8'))));
}

const installedVersion = async root => JSON.parse(await readFile(join(root, 'node_modules/@runeditrun/rer/package.json'), 'utf8')).version;

test('a fresh clone installs dependencies without provider credentials, and its deploy still receives them', { timeout: 240_000 }, async () => {
 const { root, records } = await seed('fresh', versions.first);
 assert.ok(!existsSync(join(root, 'node_modules')), 'nothing is installed yet');
 const installed = await run(process.execPath, [launcher, 'install', '--non-interactive'], { cwd: root, env: environment(credentials) });
 assert.equal(installed.code, 0, installed.stderr);
 const scripts = await recorded(records, 'install');
 assert.ok(scripts.length >= 1, 'the dependency build script ran');
 for (const names of scripts) for (const name of Object.keys(credentials)) assert.ok(!names.includes(name), `${name} never reaches a dependency build script`);

 const deployed = await run(process.execPath, [launcher, 'deploy', '--non-interactive'], { cwd: root, env: environment(credentials) });
 assert.equal(deployed.code, 0, deployed.stderr);
 const [deploy] = await recorded(records, 'deploy');
 for (const name of Object.keys(credentials)) assert.ok(deploy?.includes(name), `the seed's deploy receives ${name}`);
});

test('after a pulled pin change, rer deploy installs the new pinned package first', { timeout: 240_000 }, async () => {
 const { root, records } = await seed('pinned', versions.first);
 const installed = await run(process.execPath, [launcher, 'install', '--non-interactive'], { cwd: root, env: environment() });
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await installedVersion(root), versions.first);
 await pin(root, versions.next);
 const deployed = await run(process.execPath, [launcher, 'deploy', '--non-interactive'], { cwd: root, env: environment(credentials) });
 assert.equal(deployed.code, 0, deployed.stderr);
 assert.equal(await installedVersion(root), versions.next, 'node_modules holds the new pin');
 assert.equal((await recorded(records, 'deploy')).length, 1, 'the deploy ran');
});
