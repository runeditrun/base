import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../../bin/rer.mjs', import.meta.url));
const authoring = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = (root, ...args) => spawnSync(process.execPath,
  args[0] === 'refresh-base' ? [cli, ...args, '--json'] : [authoring, ...args], {cwd: root, encoding: 'utf8'});
function ok(root, ...args) {
  const result = run(root, ...args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(args[0] === 'refresh-base' ? result.stdout.trim().split('\n').at(-1) : result.stdout);
}

export function vendorNamespaceCases({init, write, commit, git, snapshotTree}) {
  for (const shape of ['directory', 'sparse', 'unmapped', 'ambiguous']) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-namespace-'));
    const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
    const origin = 'foundation/runtime/hydration', vendor = 'src/vendor/base/hydration';
    const route = 'src/routes/reference.tsx', source = 'default-seed/' + route;
    try {
      init(base); init(seed);
      const unit = 'export const HydrationUnit = () => "synthetic hydrated page";\n';
      write(base, origin + '/unit.tsx', unit);
      write(base, origin + '/report.ts', 'export const report = "synthetic hydration report";\n');
      write(base, 'foundation/runtime/run-site.ts', 'export const run = "synthetic run";\n');
      write(base, 'default-seed/src/routes/index.ts', 'export const page = "synthetic home";\n');
      const pin = commit(base);
      write(seed, 'src/routes/index.ts', 'export const page = "synthetic home";\n');
      ok(seed, 'record-base', 'src/routes/index.ts', 'default-seed/src/routes/index.ts', pin, '--base', base);
      if (shape !== 'unmapped') {
        write(seed, vendor + '/report.ts', 'export const report = "synthetic hydration report";\n');
        if (shape !== 'sparse') write(seed, vendor + '/unit.tsx', unit);
        ok(seed, 'record-base', vendor, origin, pin, '--base', base);
        if (shape === 'directory') for (const broader of ['src/base', 'src/site/base']) {
          write(seed, broader + '/run-site.ts', 'export const run = "synthetic run";\n');
          ok(seed, 'record-base', broader, 'foundation/runtime', pin, '--base', base);
        }
        if (shape === 'ambiguous') {
          write(seed, 'src/other/hydration/unit.tsx', unit);
          ok(seed, 'record-base', 'src/other/hydration', origin, pin, '--base', base);
        }
      }
      commit(seed);
      // A newly delivered route has Base's source layout, while the seed has
      // explicitly selected a vendor namespace for hydration.
      write(base, source, "import {HydrationUnit} from '../../../foundation/runtime/hydration/unit';\nexport const page = HydrationUnit();\n");
      write(base, 'default-seed/src/routes/index.ts', "export {page} from './reference';\n");
      write(base, 'foundation/edition-migrations.json', JSON.stringify({schemaVersion: 1, migrations:
        ['run-data-paths', 'run-data-pricing'].map(id => ({id, introduced: pin, origin: 'default-seed/src/routes/index.ts', guide: 'guide.md', edit: 'Review synthetic RunData.', deliver: []}))}));
      const next = commit(base), before = snapshotTree(seed);
      const result = run(seed, 'refresh-base', '--ref', next, '--base', base,
        '--edition-migration', 'run-data-paths', '--edition-migration', 'run-data-pricing');
      if (shape === 'unmapped' || shape === 'ambiguous') {
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, shape === 'unmapped' ? /no copy mapping witnesses/ : /ambiguous.*copy mapping/);
        assert.deepEqual(snapshotTree(seed), before);
        continue;
      }
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const bytes = fs.readFileSync(path.join(seed, route), 'utf8');
      const specifier = /from ['"]([^'"]+)['"]/.exec(bytes)[1];
      assert.equal(path.posix.normalize(path.posix.join(path.posix.dirname(route), specifier)) + '.tsx', vendor + '/unit.tsx');
      assert.equal(fs.existsSync(path.join(temp, 'foundation')), false);
      const record = JSON.parse(fs.readFileSync(path.join(seed, 'base-copies.json')));
      assert.equal(record.copies.filter(copy => copy.path.startsWith(vendor)).length, 1);
      assert.ok(record.copies.find(copy => copy.path === route).adapted[route]);
      assert.equal(ok(seed, 'verify-base', '--base', base).ok, true);
      git(seed, 'add', '-A');
      const refreshed = snapshotTree(seed);
      ok(seed, 'refresh-base', '--ref', next, '--base', base);
      assert.deepEqual(snapshotTree(seed), refreshed);
      write(seed, route, bytes + '// unacknowledged edition edit\n');
      assert.notEqual(run(seed, 'verify-base', '--base', base).status, 0);
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  }
}
