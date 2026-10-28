import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { testSource } from '../composition/git-source.mjs';

const base = resolve(import.meta.dirname, '..');

test('G8 installed authoring records and refreshes a fresh door/settings copy that typechecks without upstream tests', { timeout: 120000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-door-copy-'));
 const root = join(directory, 'seed'), archive = join(directory, 'archive');
 await mkdir(root); await mkdir(archive);
 t.after(() => rm(directory, { recursive: true, force: true }));
 const run = (program, args) => execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
 const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim();
 for (const name of execFileSync('git', ['ls-files', '-z'], { cwd: base, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  await mkdir(dirname(join(archive, name)), { recursive: true });
  await cp(join(base, name), join(archive, name));
 }
 run('git', ['init', '-q']);
 run('git', ['config', 'user.name', 'Run Edit Run fleet']);
 run('git', ['config', 'user.email', 'fleet@runeditrun.com']);
 await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
 await writeFile(join(root, '.gitignore'), 'node_modules\n');
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'));
 const sources = ['modules/agent-door', 'modules/business-settings', 'modules/operator-auth', 'foundation/runtime'];
 for (const source of sources) {
  const target = `src/base/${source}`;
  await mkdir(join(root, target), { recursive: true });
  await cp(join(base, source), join(root, target), { recursive: true, filter: path => !testSource(relative(base, path)) });
 }
 run('git', ['add', '.']);
 const cli = join(base, 'default-seed/scripts/base-cli/edition-authoring/cli.mjs');
 for (const source of sources) {
  const record = JSON.parse(run(process.execPath, [cli, 'record-base', `src/base/${source}`, source, '--base-archive', archive, '--ref', revision]));
  if (source === 'modules/agent-door') assert.ok(record.notCopied.some(testSource));
 }
 run('git', ['add', '.']);
 run(process.execPath, [join(base, 'default-seed/scripts/rer.mjs'), 'refresh-base', '--ref', revision, '--base-archive', archive]);
 const record = JSON.parse(await readFile(join(root, 'base-copies.json'), 'utf8'));
 assert.ok(record.copies.length >= 2);
 assert.ok(record.copies.every(copy => Object.keys(copy.files).every(path => !testSource(path))));
 const walk = async path => (await Promise.all((await readdir(path, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(join(path, entry.name)) : join(path, entry.name)))).flat();
 assert.ok((await walk(join(root, 'src'))).every(path => !testSource(relative(root, path))));
 await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, types: ['@cloudflare/workers-types', 'node'], noUnusedLocals: true, noUnusedParameters: true }, include: ['src'] }));
 run(process.execPath, [join(base, 'default-seed/node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
 t.diagnostic(`Fresh authoring copy: ${record.copies.length} source groups; strict typecheck PASS; no upstream tests or test typings copied.`);
});
