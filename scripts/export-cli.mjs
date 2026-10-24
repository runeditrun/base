import { cp, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { exportCLI } from '../cli/export.mjs';
import { testSource } from '../composition/git-source.mjs';
import { existsSync } from 'node:fs';
// node scripts/export-cli.mjs SEED_ROOT refreshes a seed's vendored copy;
// node scripts/export-cli.mjs --to-package SEED_ROOT [--version X] converts it
// to pin the @runeditrun/rer package instead (see export-cli/to-package.mjs).
const base = resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
if (args[0] === '--to-package') {
 const { toPackage, Refusal } = await import('./export-cli/to-package.mjs');
 const rest = args.slice(1), at = rest.indexOf('--version'), version = at < 0 ? undefined : rest.splice(at, 2)[1];
 if (rest.length !== 1 || (at >= 0 && !version)) { process.stderr.write('Usage: node scripts/export-cli.mjs --to-package SEED_ROOT [--version X]\n'); process.exit(2); }
 try { await toPackage(base, rest[0], { version }); }
 catch (error) { if (!(error instanceof Refusal)) throw error; process.stderr.write(error.message + '\n'); process.exit(error.exitCode); }
 process.exit(0);
}
if (args.length !== 1) throw Error('Usage: node scripts/export-cli.mjs SEED_ROOT, or node scripts/export-cli.mjs --to-package SEED_ROOT [--version X]');
const target = resolve(args[0]);
await exportCLI(base, target);
await rm(resolve(target, 'scripts/base-onboarding'), { recursive: true, force: true });
await cp(resolve(base, 'onboarding'), resolve(target, 'scripts/base-onboarding'), { recursive: true, filter: path => !testSource(relative(resolve(base, 'onboarding'), path)) });
// Historical runner fixtures exercise custody/recovery only. Keep them under
// tests so portable operating commands cannot use the superseded executor.
if(existsSync(resolve(target,'tests/local-setup/fixtures'))){
 const fixtures=resolve(target,'tests/local-setup/fixtures/base-onboarding/local/fixtures');
 await rm(fixtures,{recursive:true,force:true});
 await cp(resolve(base,'onboarding/local/fixtures'),fixtures,{recursive:true});
}

for (const name of ['EDITION-AUTHORING.md', 'RUN-LOCALLY.md', 'SEED-COMMAND-CONTRACT.md', 'HOMEPAGE-VARIANTS.md', 'DEMO.md']) await cp(resolve(base, 'export', name), resolve(target, name));

await cp(resolve(base, 'export/install-chromium-deps.py'), resolve(target, 'scripts/install-chromium-deps.py'));
