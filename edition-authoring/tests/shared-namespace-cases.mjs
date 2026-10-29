import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const authoring = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const publicCli = fileURLToPath(new URL('../../bin/rer.mjs', import.meta.url));

export function sharedNamespaceCases({init, write, commit, git, snapshotTree, cli = publicCli,
  shapes = ['directory', 'singleton', 'relocated', 'sparse-files', 'single', 'ambiguous', 'seed-edit']}) {
  for (const shape of shapes) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-namespace-'));
    const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
    const run = (...args) => spawnSync(process.execPath,
      args[0] === 'refresh-base' ? [cli, ...args, '--json'] : [authoring, ...args], {cwd: seed, encoding: 'utf8'});
    const ok = (...args) => {
      const result = run(...args);
      assert.equal(result.status, 0, shape + ': ' + result.stdout + result.stderr);
      return JSON.parse(args[0] === 'refresh-base' ? result.stdout.trim().split('\n').at(-1) : result.stdout);
    };
    try {
      init(base); init(seed);
      const initial = 'export const value = 1;\n';
      for (const name of ['alpha', 'beta']) write(base, `packages/${name}/index.mjs`, initial);
      write(base, 'template/routes/index.mjs', initial);
      const pin = commit(base);
      const anchors = shape === 'single' || shape === 'seed-edit' ? ['alpha'] : ['alpha', 'beta'];
      for (const name of anchors) {
        write(seed, `vendor/packages/${name}/index.mjs`, initial);
        const suffix = shape === 'singleton' ? '/index.mjs' : '';
        ok('record-base', `vendor/packages/${name}${suffix}`, `packages/${name}${suffix}`, pin, '--base', base);
      }
      if (['relocated', 'sparse-files', 'ambiguous'].includes(shape)) {
        write(seed, 'src/routes/index.mjs', initial);
        ok('record-base', 'src/routes/index.mjs', 'template/routes/index.mjs', pin, '--base', base);
      }
      if (shape === 'ambiguous') for (const name of anchors) {
        write(seed, `other/packages/${name}/index.mjs`, initial);
        ok('record-base', `other/packages/${name}`, `packages/${name}`, pin, '--base', base);
      }
      if (shape === 'sparse-files') for (const name of anchors) {
        write(seed, `other/packages/${name}/index.mjs`, initial);
        ok('record-base', `other/packages/${name}/index.mjs`, `packages/${name}/index.mjs`, pin, '--base', base);
      }
      if (shape === 'seed-edit') write(seed, 'vendor/packages/gamma/index.mjs', 'export const custom = true;\n');
      commit(seed);
      write(base, 'packages/gamma/index.mjs', "export {value} from '../delta/index.mjs';\n");
      write(base, 'packages/delta/index.mjs', 'export const value = 731;\n');
      write(base, 'packages/unrelated/index.mjs', 'throw Error("unselected");\n');
      if (['relocated', 'sparse-files', 'ambiguous'].includes(shape)) {
        write(base, 'template/routes/new.mjs', "export {value} from '../../packages/gamma/index.mjs';\n");
        write(base, 'template/routes/index.mjs', "export {value} from './new.mjs';\n");
      } else write(base, 'packages/alpha/index.mjs', "export {value} from '../gamma/index.mjs';\n");
      const next = commit(base), before = snapshotTree(seed);
      const result = run('refresh-base', '--ref', next, '--base', base);
      if (['single', 'singleton', 'ambiguous', 'seed-edit'].includes(shape)) {
        assert.equal(result.status, 4, shape + ': ' + result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, shape === 'ambiguous' ? /ambiguous.*copy mapping/ :
          shape === 'seed-edit' ? /does not export value/ : /no copy mapping witnesses/);
        assert.deepEqual(snapshotTree(seed), before);
        continue;
      }
      assert.equal(result.status, 0, shape + ': ' + result.stdout + result.stderr);
      const entry = ['relocated', 'sparse-files'].includes(shape) ? 'src/routes/index.mjs' : 'vendor/packages/alpha/index.mjs';
      const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {value} from ${JSON.stringify('./' + entry)}; if(value !== 731) process.exit(1);`], {cwd: seed, encoding: 'utf8'});
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(fs.existsSync(path.join(seed, 'vendor/packages/unrelated')), false);
      const record = JSON.parse(fs.readFileSync(path.join(seed, 'base-copies.json')));
      for (const name of ['gamma', 'delta']) assert.ok(record.copies.some(copy => copy.originPath === `packages/${name}/index.mjs`));
      assert.equal(ok('verify-base', '--base', base).ok, true);
      git(seed, 'add', '-A');
      const refreshed = snapshotTree(seed);
      ok('refresh-base', '--ref', next, '--base', base);
      assert.deepEqual(snapshotTree(seed), refreshed);
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  }
}
