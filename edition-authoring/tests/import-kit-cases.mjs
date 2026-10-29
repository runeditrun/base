import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

// Coffer records singleton copies, including an acknowledged budget adaptation.
// Exercise recovery through the commands printed by the public authoring CLI.
export function importKitClosureCases({init, write, commit, run, ok, snapshotTree}) {
  for (const {record, archive} of [
    {record: 'base-copies.json'},
    {record: "records/copy record's.json"},
    {record: 'base-copies.json', archive: true},
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-kit-closure-'));
    try {
      const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
      const origin = 'modules/import-kit/src/d1', target = `src/${origin}`;
      const budget = `${target}/budget.ts`, atomic = `${target}/atomic-prefix.ts`;
      const oldBudget = 'export const remaining = () => "base";\n';
      const oldAtomic = 'export {remaining} from "./budget.ts";\n';
      const batch = 'export const batchExecutions = (statements: number) => Number(statements > 0);\n';
      const newAtomic = 'import {batchExecutions} from "./budget.ts";\nexport const executions = batchExecutions(2);\n';
      const flags = ['--record', record];
      init(base); init(seed);
      fs.mkdirSync(path.dirname(path.join(seed, record)), {recursive: true});
      write(base, `${origin}/budget.ts`, oldBudget);
      write(base, `${origin}/atomic-prefix.ts`, oldAtomic);
      const pin = commit(base);
      write(seed, 'package.json', '{"type":"module"}\n');
      write(seed, budget, oldBudget);
      write(seed, atomic, oldAtomic);
      for (const name of ['budget.ts', 'atomic-prefix.ts']) ok(seed, 'record-base', `${target}/${name}`, `${origin}/${name}`, pin, '--base', base, ...flags);
      commit(seed);
      write(base, `${origin}/budget.ts`, oldBudget + batch);
      write(base, `${origin}/atomic-prefix.ts`, newAtomic);
      const next = commit(base);
      const source = archive ? path.join(temp, 'archive') : base;
      if (archive) {
        fs.mkdirSync(source);
        execFileSync('tar', ['-x', '-C', source], {input: execFileSync('git', ['-C', base, 'archive', next])});
      }
      const refresh = ['refresh-base', next, archive ? '--base-archive' : '--base', source, ...flags];
      // Unadapted dependencies advance together, including separate copy records.
      const original = snapshotTree(seed);
      ok(seed, ...refresh);
      assert.equal(fs.readFileSync(path.join(seed, budget), 'utf8'), oldBudget + batch);
      assert.equal(fs.readFileSync(path.join(seed, atomic), 'utf8'), newAtomic);
      ok(seed, 'verify-base', '--base', base, ...flags);
      for (const name of [record, budget, atomic]) write(seed, name, Buffer.from(original[name].bytes, 'hex'));
      const edited = oldBudget.replace('"base"', '"seed"');
      write(seed, budget, edited);
      ok(seed, 'adapt-base', budget, ...flags);
      const before = snapshotTree(seed);
      const refused = run(seed, ...refresh);
      assert.equal(refused.status, 1);
      assert.match(refused.error, /does not export batchExecutions/);
      assert.deepEqual(snapshotTree(seed), before);
      // Extract incoming bytes without replacing the seed's adaptation.
      const extract = archive ? refused.error.split('\n').find(line => line.startsWith('cp ')) : refused.error.match(/git -C .*? > '.*?\.base'/)?.[0];
      assert.ok(extract, 'refusal provides a Base extraction command');
      const extracted = spawnSync('sh', ['-c', extract], {cwd: seed, encoding: 'utf8'});
      assert.equal(extracted.status, 0, extracted.stderr);
      assert.equal(fs.readFileSync(path.join(seed, budget + '.base'), 'utf8'), oldBudget + batch);
      assert.equal(fs.readFileSync(path.join(seed, budget), 'utf8'), edited);
      // The seed author reconciles its customization with the new export.
      write(seed, budget, edited + batch);
      const unacknowledged = snapshotTree(seed);
      assert.equal(run(seed, ...refresh).status, 1, 'merged edits still require acknowledgement');
      assert.deepEqual(snapshotTree(seed), unacknowledged);
      const acknowledge = refused.error.split('\n').find(line => line.startsWith('node ') && line.includes(' adapt-base '));
      assert.ok(acknowledge, 'reconciled adaptations need a runnable acknowledgement');
      const accepted = spawnSync('sh', ['-c', acknowledge], {cwd: seed, encoding: 'utf8'});
      assert.equal(accepted.status, 0, accepted.stderr);
      fs.rmSync(path.join(seed, budget + '.base'));
      ok(seed, ...refresh);
      assert.equal(fs.readFileSync(path.join(seed, budget), 'utf8'), edited + batch);
      assert.equal(fs.readFileSync(path.join(seed, atomic), 'utf8'), newAtomic);
      ok(seed, 'verify-base', '--base', base, ...flags);
      const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `import {executions} from './${atomic}'; if (executions !== 1) process.exit(1);`], {cwd: seed, encoding: 'utf8'});
      assert.equal(loaded.status, 0, loaded.stderr);
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  }
}
