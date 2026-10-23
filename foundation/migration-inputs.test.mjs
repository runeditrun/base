import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';

test('released SQL values and their imported helpers stay immutable while unreleased inputs evolve', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-inputs-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const put = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), {recursive: true});
    fs.writeFileSync(path.join(repo, name), bytes);
  };
  const checkpoint = () => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'migration inputs');
  };
  const check = () => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/check-migrations.mjs'), '--repo', repo], {encoding: 'utf8'});
    assert.equal(result.error, undefined);
    return {status: result.status, report: JSON.parse(result.stdout)};
  };
  git('init', '-q'); git('remote', 'add', 'origin', repo);
  const module = `modules/held-${path.basename(repo)}/src/d1`;
  const helper = `${module}/${path.basename(repo)}-schema.ts`;
  const scalar = 'modules/example/storage/definition.ts';
  const sql = 'modules/example/upgrade.sql';
  const entry = `${module}/entry.ts`;
  put('foundation/initialize.mjs', `export const migrationCopies = [{repository:'base',source:'${sql}',target:'migrations/core/0001.sql'}];`);
  put('scripts/migration-exceptions.json', '[]');
  put(sql, 'CREATE TABLE upgrade (id TEXT);\n');
  put(scalar, 'export const value = `CREATE TABLE storage (id TEXT)`;\n');
  // The unseen helper has no SQL literal; only the import and value dependency
  // reveal that its bytes determine a released schema.
  put(helper, 'export const table = "held_out";\n');
  put(entry, `import {table} from './${path.basename(helper)}';\nexport const statements = [\`CREATE TABLE \${table} (id TEXT)\`];\n`);
  put(`${module}/index.ts`, "export {statements} from './entry.ts';\n");
  put('modules/example/runtime.ts', 'export const runtime = true;\n');
  checkpoint(); git('tag', 'rer-v0.0.1');
  assert.equal(check().status, 0);
  for (const name of [sql, scalar, entry, helper, `${module}/index.ts`]) {
    const original = fs.readFileSync(path.join(repo, name));
    put(name, Buffer.concat([original, Buffer.from('\n')]));
    const changed = check();
    assert.notEqual(changed.status, 0);
    assert.ok(changed.report.changes.some(item => item.path === name));
    put(name, original);
  }
  put('modules/example/runtime.ts', '// Ordinary runtime comments remain editable.\nexport const runtime = true;\n');
  put(`${module}/new-schema.ts`, 'export const next = ["CREATE TABLE next (id TEXT)"];\n');
  put('default-seed/migrations/core/0002_next.sql', 'CREATE TABLE next (id TEXT);\n');
  checkpoint();
  put(`${module}/new-schema.ts`, 'export const next = ["CREATE TABLE next (id TEXT, value TEXT)"];\n');
  assert.equal(check().status, 0);
});
