// A checkout that pins the rer package, through the installed launcher: a
// fresh clone's first rer install runs dependency build scripts with an
// allowlisted environment, never the caller's credentials, while the seed's
// own deploy still receives them; after a pulled pin change, two verbs started
// at once install the new pin once, first.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { tarball } from '../../scripts/rer-package/tarball.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { aliases, pins, verbs } from '../../cli/contract.mjs';
import { readPackage } from '../update/archive.mjs';
import { run } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');
const launcher = join(base, 'global/rer.mjs');
// Synthetic provider credentials a person has exported in their shell.
const credentials = { CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token-0001', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', SENDGRID_API_KEY: 'SG.synthetic-sendgrid-key-0001' };
// Other credentials a dependency script never sees: vault sessions, a
// connection string, a private key, an Authorization header, provider tokens,
// and any variable not on the install's allowlist, whatever it is called.
const pem = ['-----BEGIN PRIVATE KEY-----', Buffer.from('synthetic-private-key').toString('base64'), '-----END PRIVATE KEY-----'].join('\n');
const others = {
 BW_SESSION: Buffer.from('synthetic-bitwarden-session').toString('base64'), OP_SESSION_fixture: 'synthetic-1password-session', FASTLANE_SESSION: 'synthetic-cookie-jar',
 AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.from('synthetic-account-key').toString('base64')};EndpointSuffix=core.windows.net`,
 GITHUB_APP_PEM: pem, EXTRA_HEADERS: 'Authorization: Bearer synthetic-bearer-value', FIXTURE_UNKNOWN_SETTING: 'plain',
 npm_config_fixture_key: pem, RER_FIXTURE_HEADER: 'Authorization: Basic ' + Buffer.from('fixture:synthetic').toString('base64'), PNPM_FIXTURE_SESSION: 'synthetic-session',
 PGPASSWORD: 'synthetic-password', DBPASSWORD: 'synthetic-password', CLIENTSECRET: 'synthetic-secret', GPG_PASSPHRASE: 'synthetic-passphrase',
 CI_JOB_JWT: 'synthetic-jwt', DOCKER_CREDS: 'synthetic-creds', GITHUB_PAT: 'synthetic-pat', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/key.json',
 SLACK_WEBHOOK_URL: 'https://hooks.slack.example/services/synthetic', AWS_ACCESS_KEY_ID: 'synthetic-aws-id', AWS_REGION: 'us-east-1',
 cloudflare_account_id: '0123456789abcdef0123456789abcdef', npm_config__auth: Buffer.from('fixture:fixture').toString('base64'), 'npm_config_//registry.example/:_authToken': 'synthetic-npm-token',
 DATABASE_URL: 'postgres://app:synthetic-password@db.example/app', DB: 'libsql://db.example?authToken=synthetic-libsql-token',
 GH: 'ghp_' + 'synthetic0'.repeat(4), FINE: 'github_pat_' + 'synthetic0'.repeat(4), OPENAI: 'sk-proj-' + 'synthetic0'.repeat(4),
 SLACK: 'xoxb-' + 'synthetic0'.repeat(3), AMAZON: 'AKIA' + 'SYNTHETIC0'.repeat(2), SIGNED: [{ alg: 'HS256' }, { sub: 'fixture' }, 'fixture-signature'].map(part => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url')).join('.'),
};
// The install's allowlist, kept even where a value resembles a token.
const kept = {
 USER: 'fixture', LOGNAME: 'fixture', SHELL: '/bin/sh', TERM: 'dumb', LANG: 'en_US.UTF-8', LANGUAGE: 'en_US', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', CI: 'true',
 NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', SSH_AUTH_SOCK: '/synthetic/agent.sock', NODE_OPTIONS: '--max-old-space-size=4096',
 XDG_CONFIG_HOME: '/synthetic/xdg-config', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', PNPM_FIXTURE_SETTING: 'plain', npm_config_fixture_setting: 'plain', RER_STATE_DIR: '/synthetic/hf_models_cache_state',
};
// A proxy reaches the install without its user:password, whatever the password holds.
const proxies = [
 ['HTTPS_PROXY', 'http://fixture:synthetic-password@proxy.invalid:3128', 'http://proxy.invalid:3128'],
 ['http_proxy', 'http://fixture:synthetic pass word@proxy.invalid:3128', 'http://proxy.invalid:3128'],
 ['ALL_PROXY', '  socks5://fixture:synthetic@password@proxy.invalid:1080', 'socks5://proxy.invalid:1080'],
 ['https_proxy', 'fixture:synthetic-password@proxy.invalid:3128', 'proxy.invalid:3128'],
];
const proxy = Object.fromEntries(proxies.map(([name, value]) => [name, value]));

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
 const record = kind => `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(records)}, '${kind}-' + process.pid + '.json'), JSON.stringify(process.env))`;
 await writeFile(join(root, 'probe/package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { install: 'node record.cjs' } }));
 await writeFile(join(root, 'probe/record.cjs'), record('install') + ';\n');
 await writeFile(join(root, 'adapter.mjs'), `import { createRequire } from 'node:module';
import { localInstaller } from '@runeditrun/rer/local-installer';
import { commandAdapter } from '@runeditrun/rer/adapter';
const require = createRequire(import.meta.url);
const never = ['node', ['-e', 'process.exit(9)']], ok = ['node', ['-e', '']];
const deploy = Object.assign(async () => { ${record('deploy')}; return { deployed: true, origin: 'https://seed.example.test' }; }, { managesHostedOwner: true });
const adapter = commandAdapter(localInstaller({ build: ok, migrate: never, start: never, owner: {}, signIn: {} }), { preview: never, verify: never, deploy, deployDeclaration: 'deploy.json', portability: { export: () => {}, import: () => {} }, input: { names: { email: 'email', name: 'displayName' }, validate: value => value } });
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
 await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'seed', private: true, packageManager: `pnpm@${pins.pnpm}`, engines: { node: pins.node }, scripts: Object.fromEntries(Object.entries(aliases).map(([alias, verb]) => [alias, verb ? `rer ${verb}` : 'rer'])), devDependencies: { '@runeditrun/rer': version, probe: 'file:./probe' }, pnpm: { onlyBuiltDependencies: ['probe'] } }));
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

test('a fresh clone installs dependencies without credentials, and its deploy still receives them', { timeout: 240_000 }, async () => {
 const { root, records } = await seed('fresh', versions.first);
 assert.ok(!existsSync(join(root, 'node_modules')), 'nothing is installed yet');
 const installed = await run(process.execPath, [launcher, 'install', '--non-interactive'], { cwd: root, env: environment({ ...credentials, ...others, ...kept, ...proxy }) });
 assert.equal(installed.code, 0, installed.stderr);
 const scripts = await recorded(records, 'install');
 assert.ok(scripts.length >= 1, 'the dependency build script ran');
 for (const seen of scripts) {
  for (const name of Object.keys({ ...credentials, ...others })) assert.ok(!(name in seen), `${name} never reaches a dependency build script`);
  assert.ok(seen.PATH?.includes(process.env.PATH), 'PATH reaches the dependency build script');
  for (const [name, value] of Object.entries({ HOME: environment().HOME, ...kept })) assert.equal(seen[name], value, `${name} reaches the dependency build script`);
  for (const [name, , stripped] of proxies) assert.equal(seen[name], stripped, `${name} reaches the install without its user:password`);
 }

 const deployed = await run(process.execPath, [launcher, 'deploy', '--non-interactive'], { cwd: root, env: environment(credentials) });
 assert.equal(deployed.code, 0, deployed.stderr);
 const [deploy] = await recorded(records, 'deploy');
 for (const name of Object.keys(credentials)) assert.ok(deploy && name in deploy, `the seed's deploy receives ${name}`);
});

test('after a pulled pin change, two verbs started at once share one install of the new pinned package', { timeout: 240_000 }, async () => {
 const { root, records } = await seed('pinned', versions.first);
 const installed = await run(process.execPath, [launcher, 'install', '--non-interactive'], { cwd: root, env: environment() });
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await installedVersion(root), versions.first);
 const before = (await recorded(records, 'install')).length;
 await pin(root, versions.next);
 const builds = await Promise.all([0, 1].map(() => run(process.execPath, [launcher, 'build', '--non-interactive'], { cwd: root, env: environment() })));
 // Exit 4: the other build held the checkout's local state, as rer reports.
 for (const { code, stderr } of builds) assert.ok(code === 0 || code === 4, `exit ${code}: ${stderr}`);
 assert.ok(builds.some(({ code }) => code === 0), 'one build ran');
 assert.equal(await installedVersion(root), versions.next, 'node_modules holds the new pin');
 assert.equal((await recorded(records, 'install')).length, before + 1, 'the new pin was installed once');
});
