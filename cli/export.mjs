import { cp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { testSource } from '../composition/git-source.mjs';
import { cliVersion } from './version.mjs';

// Copy whole maintained source/tooling directories. Python publication scans
// load sibling modules and data dynamically; they belong in the inventory too.
export const sourceRoots = ['default-seed/public/rer-theme.css', 'default-seed/public/brand/mark.svg', 'default-seed/public/fonts/outfit', 'bin/rer.mjs', 'cli', 'modules/delivery-producer/declarations.mjs', 'modules/delivery-producer/bindings.mjs', 'modules/delivery-producer/migrations.mjs', 'modules/delivery-producer/mail.mjs', 'modules/job-queue', 'modules/release', 'modules/deploy-kit', 'modules/site', 'modules/container', 'modules/demo-host', 'modules/demo', 'modules/integrations/core', 'modules/mail', 'modules/ai', 'modules/portability', 'modules/d1-transport', 'modules/import-kit/src/d1', 'modules/import-kit/src/door', 'modules/import-kit/src/readers', 'modules/import-kit/src/provenance/numeric-credentials.ts', 'modules/import-kit/src/types.ts', 'modules/import-kit/src/plan', 'modules/import-kit/src/provenance/canonical-hash.ts', 'modules/import-kit/src/provenance/canonical-stream.ts', 'modules/import-kit/src/provenance/credential-names.ts', 'modules/import-kit/src/provenance/credentials.ts', 'modules/import-kit/src/provenance/identity.ts', 'modules/import-kit/src/provenance/json-snapshot.ts', 'modules/import-kit/src/provenance/resumable-sha256.ts', 'modules/import-kit/src/provenance/validate-json.ts', 'modules/import-kit/src/journal/authority.ts', 'modules/import-kit/src/storage/originals.ts', 'modules/import-kit/src/storage/provenance.ts', 'modules/import-kit/src/storage/schema.ts', 'modules/erasure', 'modules/dependencies', 'modules/operator-auth', 'modules/owner-claim', 'operations', 'scripts/publish-check', 'scripts/publish-check.mjs', 'composition/git-source.mjs', 'edition-authoring/adopt.mjs', 'edition-authoring/base-acknowledgements.mjs', 'edition-authoring/base-copies.mjs', 'edition-authoring/module-closure.mjs', 'edition-authoring/edition-migrations.mjs', 'edition-authoring/cli.mjs', 'edition-authoring/copy-checkout.mjs', 'edition-authoring/files.mjs', 'edition-authoring/lock.mjs', 'edition-authoring/manifest.mjs', 'edition-authoring/offline-git.mjs', 'edition-authoring/parent-comparison.mjs', 'edition-authoring/projection-lock.mjs', 'edition-authoring/release.mjs', 'edition-authoring/runtime-dependencies.mjs', 'edition-authoring/module-resolution.mjs', 'edition-authoring/package-target.mjs', 'edition-authoring/module-syntax.mjs', 'edition-authoring/module-edges.mjs', 'edition-authoring/vendor/babel-parser', 'edition-authoring/workflow-copies.mjs', 'edition-authoring/workflow-scripts.mjs', 'edition-authoring/vendor/yaml', 'edition-authoring/sources.mjs', 'edition-authoring/updates.mjs', 'foundation/runtime/seed-contract.mjs', 'foundation/runtime/run-data.mjs', 'foundation/runtime/run-data.d.mts', 'foundation/runtime/contract-docs.mjs'];
sourceRoots.push('modules/agent-door/conformance');
sourceRoots.push('foundation/runtime/contract-prose.mjs', 'foundation/runtime/contract-prose-patterns.mjs');
export async function inventory(base, roots = sourceRoots) {
 const files = [];
 async function walk(path) {
  for (const entry of (await readdir(resolve(base, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
   if (['node_modules', '__pycache__', '.state', '.wrangler', '.rer', '.seed', '.cache'].includes(entry.name)) continue;
   const name = `${path}/${entry.name}`;
   if (testSource(name)) continue;
   if (entry.isDirectory()) await walk(name);
   else if (entry.isFile()) files.push(name);
   else throw Error('Non-file CLI export source');
  }
 }
 for (const source of roots) {
  const stat = await lstat(resolve(base, source));
  if (stat.isFile()) files.push(source);
  else if (stat.isDirectory()) await walk(source);
  else throw Error('Non-file CLI export source');
 }
 return files.sort();
}

export async function exportCLI(base, destination) {
 const target = resolve(destination, 'scripts/base-cli');
 await rm(target, { recursive: true, force: true });
 await mkdir(target, { recursive: true });
 const files = await inventory(base), record = {};
 for (const path of files) {
  const bytes = await readFile(resolve(base, path));
  await mkdir(dirname(resolve(target, path)), { recursive: true });
  await cp(resolve(base, path), resolve(target, path));
  record[path] = { source: path, sha256: createHash('sha256').update(bytes).digest('hex') };
 }
 const onboardingFiles=Object.fromEntries(await Promise.all((await inventory(base,['onboarding'])).map(async path=>[path.slice('onboarding/'.length),{source:path,sha256:createHash('sha256').update(await readFile(resolve(base,path))).digest('hex')}])));
 // cliVersion: the rer version of this Base source, which `rer describe` reports.
 const version = cliVersion(base);
 await writeFile(resolve(target, 'inventory.json'), JSON.stringify({ version: 1, ...(version ? { cliVersion: version } : {}), onboarding: '../base-onboarding', onboardingFiles, files: record }, null, 2) + '\n');
 await writeFile(resolve(destination, 'scripts/rer.mjs'), "#!/usr/bin/env node\nimport { main } from './base-cli/cli/main.mjs';\nprocess.exitCode = await main();\n");
}
