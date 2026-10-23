import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

const base = path.resolve(import.meta.dirname, '..');
test('adapt-base and refresh-base preserve migration history and check enforces acknowledged auth adaptations', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rer-auth-adaptation-'));
 t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
 const upstream = path.join(dir, 'base'), seed = path.join(dir, 'seed');
 const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
 const write = (root, name, bytes) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), bytes); };
 for (const root of [upstream, seed]) {
  fs.mkdirSync(root); git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
 }
 const commit = () => { git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'fixture'); return git(upstream, 'rev-parse', 'HEAD'); };
 const author = (...args) => {
  const result = spawnSync(process.execPath, [path.join(base, 'edition-authoring/cli.mjs'), ...args], {cwd: seed, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
 };
 const check = () => {
  const result = spawnSync(process.execPath, [path.join(base, 'bin/rer.mjs'), 'check', '--profile', 'first-party', '--json'], {cwd: seed, encoding: 'utf8'});
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const clauses = report.clauses.filter(item => item.id.startsWith('SC-05.auth-copy.'));
  assert.ok(clauses.length); return clauses.filter(item => !item.ok);
 };
 write(seed, 'task.mjs', 'process.exit(0);\n');
 write(seed, 'OPERATIONS.json', JSON.stringify({version: 2, project: 'example/auth', runtime: {requirements: [{name: 'node', version: 'project-owned'}]}, requiredEnvironment: [], commands: {verify: {argv: ['node', 'task.mjs'], inputs: ['task.mjs'], effects: 'Runs the fixture.'}}}));
 const origin = 'modules/operator-auth/accounts', runtime = 'src/auth/runtime.mjs', migration = 'migrations/core/0001_owner.sql';
 write(upstream, origin + '/runtime.mjs', 'export const value = "base";\n');
 write(upstream, origin + '/schema/operator-auth.sql', 'CREATE TABLE operators (id TEXT);\n');
 const old = commit();
 write(seed, runtime, fs.readFileSync(path.join(upstream, origin, 'runtime.mjs')));
 write(seed, migration, fs.readFileSync(path.join(upstream, origin, 'schema/operator-auth.sql')));
 author('record-base', 'src/auth', origin, old, '--base', upstream);
 author('record-base', migration, origin + '/schema/operator-auth.sql', old, '--base', upstream);
 const original = fs.readFileSync(path.join(seed, migration));
 write(seed, runtime, 'export const value = "seed";\n');
 assert.ok(check().some(item => item.id.endsWith(runtime)));
 author('adapt-base', runtime); author('adapt-base', migration);
 write(upstream, origin + '/runtime.mjs', 'export const value = "new base";\n');
 write(upstream, origin + '/schema/operator-auth.sql', 'CREATE TABLE operators (id TEXT, name TEXT);\n');
 write(upstream, origin + '/schema/name.sql', 'ALTER TABLE operators ADD COLUMN name TEXT;\n');
 const next = commit();
 const refreshed = author('refresh-base', next, '--base', upstream);
 assert.ok(refreshed.adapted.find(item => item.path === migration)?.conflict);
 assert.ok(refreshed.schemaDeltas.some(item => item.path === 'src/auth/schema/name.sql' && item.diffHint));
 assert.deepEqual(fs.readFileSync(path.join(seed, migration)), original);
 assert.deepEqual(check(), []);
 assert.equal(author('verify-base', '--base', upstream).ok, true);
 const recordPath = path.join(seed, 'base-copies.json'), record = fs.readFileSync(recordPath);
 const missing = JSON.parse(record); delete missing.copies.find(item => item.path === 'src/auth').acknowledged;
 fs.writeFileSync(recordPath, JSON.stringify(missing));
 assert.ok(check().some(item => item.id.endsWith(runtime)));
 fs.writeFileSync(recordPath, record);
 fs.chmodSync(path.join(seed, runtime), 0o755);
 assert.ok(check().some(item => item.id.endsWith(runtime)));
 fs.chmodSync(path.join(seed, runtime), 0o644);
 write(seed, runtime, 'export const value = "unacknowledged";\n');
 assert.ok(check().some(item => item.id.endsWith(runtime)));
 author('adapt-base', runtime);
 assert.deepEqual(check(), []);
 const invalid = JSON.parse(fs.readFileSync(recordPath));
 invalid.copies.find(item => item.path === migration).adapted[migration] = 'invalid';
 fs.writeFileSync(recordPath, JSON.stringify(invalid));
 assert.ok(check().some(item => item.id.includes(migration)));
});
