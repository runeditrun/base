import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isolatedQueue } from './fixtures/queue.mjs';
const base = join(import.meta.dirname, '..');

for (const failure of [false, true]) test(`rer build hides declared JSON settings and backups and restores exact modes after ${failure ? 'failure' : 'success'}`, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-build-private-')); t.after(() => rm(root, { recursive: true, force: true }));
 const pins=JSON.parse(await readFile(join(base,'default-seed/package.json'),'utf8'));
 await writeFile(join(root,'.node-version'),pins.engines.node+'\n');
 await writeFile(join(root,'package.json'),JSON.stringify({engines:pins.engines,packageManager:pins.packageManager}));
 const env = await isolatedQueue(t, { PATH: process.env.PATH, TZ: 'UTC' });
 await mkdir(join(root, 'data'), { mode: 0o700 });
 await mkdir(join(root, '.rer/local'), { recursive: true, mode: 0o700 });
 const files = { '.dev.vars': ['# retained default settings\n', 0o600], '.dev.vars.previous': ['default backup\n', 0o400], 'data/local-secrets.json': ['{"SESSION_SECRET":"synthetic-json"}\n', 0o600], 'data/local-secrets-backup.json': ['{"retained":"backup"}\n', 0o400], '.rer/local/models.json': ['{"key":"synthetic-dev-app-key"}\n', 0o600] };
 for (const [file, [bytes, mode]] of Object.entries(files)) await writeFile(join(root, file), bytes, { mode });
 const settings = ['data/local-secrets.json', 'data/local-secrets-backup.json'];
 const adapter = `import {localInstaller} from ${JSON.stringify(pathToFileURL(join(base, 'onboarding/adapter.mjs')).href)};
import {commandAdapter as create} from ${JSON.stringify(pathToFileURL(join(base, 'cli/adapter.mjs')).href)};
const lifecycle=localInstaller({tools:[],secrets:{file:'data/local-secrets.json',format:'json'},build:[process.execPath,['build.mjs']]});
export const commandAdapter=create(lifecycle,{settings:${JSON.stringify(settings)},input:{names:{email:'email',name:'displayName'},validate:x=>x}});`;
 await writeFile(join(root, 'adapter.mjs'), adapter);
 await writeFile(join(root, 'build.mjs'), `import {existsSync,writeFileSync} from 'node:fs';for(const file of ${JSON.stringify(Object.keys(files))})if(existsSync(file))process.exit(19);writeFileSync('build-ran','yes');process.exit(${failure ? 7 : 0});`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/build', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { build: { argv: ['node', 'build.mjs'], inputs: ['build.mjs'], effects: 'Builds the fixture.' } } }));
 const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'build', '--json', '--non-interactive'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
 assert.equal(result.status, failure ? 1 : 0, result.stderr);
 assert.equal(await readFile(join(root, 'build-ran'), 'utf8'), 'yes', 'actual child saw no private files');
 for (const [file, [bytes, mode]] of Object.entries(files)) {
  assert.equal(await readFile(join(root, file), 'utf8'), bytes, file);
  assert.equal((await stat(join(root, file))).mode & 0o7777, mode, file);
 }
 assert.equal((await stat(join(root, 'data'))).mode & 0o7777, 0o700);
});
