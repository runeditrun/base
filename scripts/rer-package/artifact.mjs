// Small exact-package release gate. No global rer, cached pin or source imports.
// node scripts/rer-package/artifact.mjs TARBALL [--base CHECKOUT] [--ref COMMIT] [--out DIR]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { doorSmoke } from './artifact-door.mjs';
import { refreshSmoke } from './artifact-refresh.mjs';

export const surfaces = [
 { surface: 'import-kit/door', entry: '@runeditrun/rer/modules/import-kit/door', check: 'bundle delivered runtime; CSV/JSON/NDJSON projection, refusals, plan/apply/reconcile/replay/Undo; compile public types' },
 { surface: 'import-kit/d1', entry: '@runeditrun/rer/modules/import-kit/d1', check: 'bundle and initialize delivered D1 engine used by the door; compile public types' },
 { surface: 'edition-authoring', entry: 'edition-authoring/cli.mjs', check: 'fresh Pegboard refresh; local and package verify-base against source records, SHA-256 and unrecorded copies; repeat refresh' },
];

export async function artifactSmoke(tarball, { base = resolve(import.meta.dirname, '../..'), ref, out } = {}) {
 base = resolve(base); tarball = resolve(tarball);
 ref ??= execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
 const root = mkdtempSync(join(tmpdir(), 'rer-artifact-'));
 const output = out ? resolve(out) : join(root, 'output'); mkdirSync(output, { recursive: true });
 const home = join(root, 'home'); mkdirSync(home);
 const npmrc = join(root, 'npmrc'); writeFileSync(npmrc, '');
 const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), CI: 'true',
  NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: join(root, 'global-npmrc'), npm_config_cache: join(root, 'npm-cache'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
 writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
 let sequence = 0;
 function run(command, args, { cwd = root } = {}) {
  const log = join(output, String(++sequence).padStart(2, '0') + '.json');
  try {
   const stdout = execFileSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
   writeFileSync(log, JSON.stringify({ command: [command, ...args], cwd, status: 0, stdout }, null, 2) + '\n'); return stdout;
  } catch (error) {
   writeFileSync(log, JSON.stringify({ command: [command, ...args], cwd, status: error.status, stdout: error.stdout?.toString(), stderr: error.stderr?.toString() }, null, 2) + '\n');
   throw new Error(`${command} ${args.join(' ')} failed (${error.status}): ${error.stderr?.toString() || error.stdout?.toString()}`, { cause: error });
  }
 }
 const results = [];
 try {
  const dependencies = JSON.parse(readFileSync(join(base, 'default-seed/package.json'))).devDependencies;
  run('npm', ['install', '--prefix', root, '--no-audit', '--no-fund', tarball, ...['esbuild', 'typescript', '@types/node'].map(name => name + '@' + dependencies[name])]);
  const installed = join(root, 'node_modules/@runeditrun/rer');
  const require = createRequire(join(root, 'package.json'));
  const { build } = require('esbuild');
  async function check(surface, operation) {
   try { results.push({ surface, ok: true, result: await operation() }); }
   catch (error) { results.push({ surface, ok: false, error: error.stack }); }
  }
  await check('import-kit/door + d1', async () => {
   const entry = join(root, 'entry.mjs');
   await build({ absWorkingDir: root, stdin: { contents: "export * as door from '@runeditrun/rer/modules/import-kit/door'; export * as d1 from '@runeditrun/rer/modules/import-kit/d1';", resolveDir: root },
    outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', metafile: true });
   writeFileSync(join(root, 'types.mts'), "import type { ImportDoorIntake, ImportOperatorOptions } from '@runeditrun/rer/modules/import-kit/door';\nimport type { D1Database } from '@runeditrun/rer/modules/import-kit/d1';\nexport type PublicTypes = [ImportDoorIntake, ImportOperatorOptions, D1Database];\n");
   run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--allowImportingTsExtensions', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2023,DOM', join(root, 'types.mts')]);
   return doorSmoke(entry);
  });
  await check('edition-authoring', () => refreshSmoke({ root, installed, base, ref, run, output }));
  const bytes = readFileSync(tarball), manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
  const report = { version: manifest.version, tarball, sha256: createHash('sha256').update(bytes).digest('hex'),
   source: { commit: ref, tree: execFileSync('git', ['-C', base, 'rev-parse', ref + '^{tree}'], { encoding: 'utf8' }).trim() }, surfaces, results };
  writeFileSync(join(output, 'artifact.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  assert.ok(results.every(result => result.ok), 'packed release surfaces failed');
  return report;
 } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] === import.meta.filename) {
 const [tarball, ...args] = process.argv.slice(2), options = {};
 if (!tarball || args.length % 2) throw Error('Usage: artifact.mjs TARBALL [--base CHECKOUT] [--ref COMMIT] [--out DIR]');
 for (let i = 0; i < args.length; i += 2) {
  if (!['--base', '--ref', '--out'].includes(args[i])) throw Error('Unknown artifact smoke option');
  options[args[i].slice(2)] = args[i + 1];
 }
 await artifactSmoke(tarball, options);
}
