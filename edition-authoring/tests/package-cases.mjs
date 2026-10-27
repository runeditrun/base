import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function packageClasses({fixture, write, commit, ok, run, snapshotTree}) {
  const forms = [
    [false, spec => `import {value} from '${spec}';export const a=value;`],
    [false, spec => `import * as ns from '${spec}';export const a=ns.value;`],
    [false, spec => `import '${spec}';export const a=1;`],
    [false, spec => `import value from '${spec}';export const a=value;`],
    [false, spec => `export const a=await import('${spec}');`],
    [false, spec => `export * from '${spec}';`],
    [false, spec => `export {value} from '${spec}';`],
    [true, spec => `exports.a=require('${spec}').value;`],
  ];
  for (const [cjs, form] of forms) for (const positive of [false, true]) fixture(({base, seed}) => {
    const entry = cjs ? 'a.cjs' : 'a.mjs', initial = cjs ? 'exports.a=1;\n' : 'export const a=1;\n';
    const metadata = JSON.stringify({name: 'fixture-self', type: 'module', exports: {'./b': {
      types: './b.d.mts', ...(positive ? {import: './b.mjs', require: './b.cjs', default: './missing.mjs'} : {}),
    }}});
    write(base, 'modules/package/' + entry, initial);
    write(base, 'modules/package/package.json', metadata);
    write(base, 'modules/package/b.d.mts', 'export declare const value: number;\n');
    const original = commit(base);
    for (const [name, bytes] of [[entry, initial], ['package.json', metadata], ['b.d.mts', 'export declare const value: number;\n']]) {
      write(seed, 'vendor/' + name, bytes);
      ok(seed, 'record-base', 'vendor/' + name, 'modules/package/' + name, original, '--base', base);
    }
    commit(seed);
    assert.equal(spawnSync(process.execPath, [path.join(seed, 'vendor', entry)]).status, 0);
    write(base, 'modules/package/' + entry, form('fixture-self/b') + '\n');
    if (positive) {
      write(base, 'modules/package/b.mjs', 'export const value=731;export default value;\n');
      write(base, 'modules/package/b.cjs', 'exports.value=731;\n');
    }
    const next = commit(base), before = snapshotTree(seed), result = run(seed, 'refresh-base', next, '--base', base);
    assert.equal(result.status, positive ? 0 : 1, result.error);
    if (!positive) assert.deepEqual(snapshotTree(seed), before);
    assert.equal(ok(seed, 'verify-base', '--base', base).ok, true);
    assert.equal(spawnSync(process.execPath, [path.join(seed, 'vendor', entry)]).status, 0);
  });
}
