import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function closureClasses({init, write, commit, git, run, ok, snapshotTree}) {
  const forms = [
    spec => `import * as ns from '${spec}';`,
    spec => `import '${spec}';`,
    spec => `import value from '${spec}';`,
    spec => `import {value} from '${spec}';`,
    spec => `export * from '${spec}';`,
    spec => `export {value} from '${spec}';`,
    spec => `await import('${spec}');`,
    spec => `const value = require('${spec}');`,
    spec => 'export const message = `${(await import("' + spec + '")).value}`;',
    spec => 'export const message = `${(await import(`' + spec + '`)).value}`;',
    spec => `module['require']('${spec}');`,
    spec => `require?.('${spec}');`,
    spec => `(require)('${spec}');`,
    spec => `require.call(null, '${spec}');`,
    spec => `require.apply(null, ['${spec}']);`,
    spec => `import {createRequire} from 'node:module'; const load=createRequire(import.meta.url);load('${spec}');`,
  ];
  function fixture(callback) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-classes-'));
    const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
    try {
      init(base); init(seed);
      write(seed, 'edition.json', JSON.stringify({components: [{id: 'runeditrun/base', role: 'foundation', source: {kind: 'local', origin: {repository: base}}}]}));
      callback({base, seed});
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  }
  // R1: all runtime forms share resolution, regardless of their binding names.
  for (const [i, form] of forms.entries()) fixture(({base, seed}) => {
    write(base, 'modules/library/a.mjs', 'export const a=1;\n');
    write(base, 'modules/library/b.d.mts', 'export declare const value: number;\n');
    const pin = commit(base);
    write(seed, 'vendor/a.mjs', 'export const a=1;\n');
    ok(seed, 'record-base', 'vendor/a.mjs', 'modules/library/a.mjs', pin, '--base', base);
    commit(seed);
    write(base, 'modules/library/a.mjs', form('./b.mjs') + '\n');
    const next = commit(base), before = snapshotTree(seed);
    assert.equal(run(seed, 'refresh-base', next, '--base', base).status, 1, `runtime form ${i}`);
    assert.deepEqual(snapshotTree(seed), before);
  });
  // R3: equal bytes never grant ownership, for either selection shape or mode.
  for (const directory of [false, true]) for (const mode of [0o644, 0o755]) fixture(({base, seed}) => {
    const bytes = '#!/usr/bin/env node\nexport const value=731;\n';
    write(base, 'modules/library/a.mjs', 'export const a=1;\n');
    const pin = commit(base);
    write(seed, 'vendor/a.mjs', 'export const a=1;\n');
    ok(seed, 'record-base', directory ? 'vendor' : 'vendor/a.mjs', directory ? 'modules/library' : 'modules/library/a.mjs', pin, '--base', base);
    write(seed, 'vendor/b.mjs', bytes); fs.chmodSync(path.join(seed, 'vendor/b.mjs'), mode); commit(seed);
    write(base, 'modules/library/a.mjs', "import {value} from './b.mjs';export const a=value;\n");
    write(base, 'modules/library/b.mjs', bytes); fs.chmodSync(path.join(base, 'modules/library/b.mjs'), mode === 0o755 ? 0o644 : 0o755);
    const next = commit(base);
    ok(seed, 'refresh-base', next, '--base', base);
    assert.equal(fs.readFileSync(path.join(seed, 'vendor/b.mjs'), 'utf8'), bytes);
    assert.equal(fs.statSync(path.join(seed, 'vendor/b.mjs')).mode & 0o777, mode);
    const record = JSON.parse(fs.readFileSync(path.join(seed, 'base-copies.json')));
    assert.equal(record.copies.some(copy => Object.hasOwn(copy.files, 'vendor/b.mjs')), false);
    assert.equal(ok(seed, 'verify-base', '--base', base).ok, true);
  });
  // R4: old ordinary missing edges remain missing, even with a new Base file.
  for (const directory of [false, true]) for (const added of [false, true]) for (const form of forms.slice(0, 2)) fixture(({base, seed}) => {
    const bytes = form('./b.mjs') + '\nexport const a=1;\n';
    write(base, 'modules/library/a.mjs', bytes);
    if (!added) write(base, 'modules/library/b.mjs', 'export const value=1;\n');
    const pin = commit(base);
    write(seed, 'vendor/a.mjs', bytes);
    ok(seed, 'record-base', directory ? 'vendor' : 'vendor/a.mjs', directory ? 'modules/library' : 'modules/library/a.mjs', pin, '--base', base); commit(seed);
    write(base, 'modules/library/a.mjs', bytes + '// updated\n');
    if (added) write(base, 'modules/library/b.mjs', 'export const value=1;\n');
    const next = commit(base);
    ok(seed, 'refresh-base', next, '--base', base);
    assert.equal(fs.existsSync(path.join(seed, 'vendor/b.mjs')), false);
    const record = JSON.parse(fs.readFileSync(path.join(seed, 'base-copies.json')));
    assert.equal(record.copies.some(copy => Object.hasOwn(copy.files, 'vendor/b.mjs')), false);
  });
}
