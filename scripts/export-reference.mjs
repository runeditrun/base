import { cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, basename } from 'node:path';
import { exportCLI } from '../cli/export.mjs';
import { createHash } from 'node:crypto';
import { testSource } from '../composition/git-source.mjs';
import { exportBusinessSettings } from '../export/business-settings.mjs';

export async function exportReference(base, target) {
 const reference = resolve(base, 'default-seed'), excluded = new Set(['node_modules', 'dist', '.wrangler', '.rer', '.cache', '.state', '.dev.vars', '.dev.vars.previous', '.seed', 'scripts/base-cli', 'scripts/base-onboarding', 'playwright-report', 'test-results']);
 await mkdir(target);
 await cp(reference, target, { recursive: true, filter: path => !excluded.has(basename(path)) && !['scripts/base-cli', 'scripts/base-onboarding'].includes(relative(reference, path)) });
 const runtime = source => ({ recursive: true, filter: path => !testSource(relative(source, path)) && !['node_modules', '__pycache__', '.state', '.cache', '.wrangler'].includes(basename(path)) });
 await cp(resolve(base, 'onboarding'), resolve(target, 'scripts/base-onboarding'), runtime(resolve(base, 'onboarding')));
 await cp(resolve(base, 'modules/mail'), resolve(target, 'src/modules/mail'), runtime(resolve(base, 'modules/mail')));
 await cp(resolve(base, 'modules/ai'), resolve(target, 'src/modules/ai'), runtime(resolve(base, 'modules/ai')));
 for(const name of ['dependencies','owner-claim','demo'])await cp(resolve(base,'modules/'+name),resolve(target,'src/modules/'+name),runtime(resolve(base,'modules/'+name)));
 await cp(resolve(base, 'modules/operator-auth'), resolve(target, 'src/modules/operator-auth'), runtime(resolve(base, 'modules/operator-auth')));
 // The Worker's erasure route runs these at runtime; `vite dev` serves only src.
 for (const name of ['portability', 'd1-transport', 'erasure']) await cp(resolve(base, 'modules', name), resolve(target, 'src/modules', name), runtime(resolve(base, 'modules', name)));
 // People imports and their erasure run on import-kit's D1 engine.
 for (const part of ['src', 'schema', 'CONTRACT.md']) await cp(resolve(base, 'modules/import-kit', part), resolve(target, 'src/modules/import-kit', part), runtime(resolve(base, 'modules/import-kit', part)));
 await cp(resolve(base, 'foundation/runtime'), resolve(target, 'src/base'), { recursive: true });
 const business = await exportBusinessSettings(base, target);
 await exportCLI(base, target);
 for (const name of ['RUN-LOCALLY.md','SEED-COMMAND-CONTRACT.md','HOMEPAGE-VARIANTS.md','VERIFY-WORKFLOW.md','DEMO.md']) await cp(resolve(base,'export',name), resolve(target,name));
 await mkdir(resolve(target, '.github/workflows'), { recursive: true });
 for (const name of ['verify.yml', 'verify-nightly.yml']) await cp(resolve(base, 'export', name), resolve(target, '.github/workflows', name));
 await cp(resolve(base,'LICENSE'), resolve(target,'LICENSE'));
 const idp = 'modules/operator-auth/identity/oidc/tests/idp.mjs', idpTarget = 'tests/operator-auth/idp.mjs';
 const maps = { ...business.maps, [resolve(base, 'modules/dependencies')]: resolve(target, 'src/modules/dependencies'), [resolve(base, 'modules/owner-claim')]: resolve(target, 'src/modules/owner-claim'), [resolve(base, 'modules/demo')]: resolve(target, 'src/modules/demo'), [resolve(base, idp)]: resolve(target, idpTarget), [resolve(base, 'onboarding')]: resolve(target, 'scripts/base-onboarding'), [resolve(base, 'modules/mail')]: resolve(target, 'src/modules/mail'), [resolve(base, 'modules/ai')]: resolve(target, 'src/modules/ai'), [resolve(base, 'modules/operator-auth')]: resolve(target, 'src/modules/operator-auth'), [resolve(base, 'foundation/runtime')]: resolve(target, 'src/base'), [resolve(base, 'modules/portability')]: resolve(target, 'src/modules/portability'), [resolve(base, 'modules/erasure')]: resolve(target, 'src/modules/erasure'), [resolve(base, 'modules/import-kit')]: resolve(target, 'src/modules/import-kit') };
 const helper = 'scripts/install-chromium-deps.py', helperSource = 'export/install-chromium-deps.py';
 await cp(resolve(base, helperSource), resolve(target, helper));
 const sources = { ...business.sources, [helper]: { source: helperSource, sha256: createHash('sha256').update(await readFile(resolve(target, helper))).digest('hex') } };
 function relocate(bytes, original, file) {
  return bytes.replace(/(['"])(\.\.[^'"\n]+)\1/g, (literal, quote, specifier) => {
   const absolute = resolve(dirname(original), specifier);
   for (const [source, destination] of Object.entries(maps)) if (absolute === source || absolute.startsWith(source + '/')) {
    let next = relative(dirname(file), resolve(destination, relative(source, absolute))).replaceAll('\\', '/'); if (!next.startsWith('.')) next = './' + next;
    return quote + next + quote;
   }
   return literal;
  });
 }
 async function adapt(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
   const file = resolve(path, entry.name), name = relative(target, file);
   if (entry.isDirectory()) { if (!['base-cli', 'base-onboarding', 'modules'].includes(entry.name)) await adapt(file); }
   else if (/\.(mjs|mts|ts|tsx)$/.test(name) && !business.sources[name]) {
    const original = resolve(reference, name); let bytes = await readFile(file, 'utf8');
    bytes = relocate(bytes, original, file);
    await writeFile(file, bytes);
    sources[name] = { source: 'default-seed/' + name, sha256: createHash('sha256').update(bytes).digest('hex'), transformation: 'Contained runtime import relocation' };
   }
  }
 }
 await adapt(target);
 // Keep the adopting OIDC network-edge fixture, without copying Base's suite.
 const idpBytes = relocate(await readFile(resolve(base, idp), 'utf8'), resolve(base, idp), resolve(target, idpTarget));
 await writeFile(resolve(target, idpTarget), idpBytes);
 sources[idpTarget] = { source: idp, sha256: createHash('sha256').update(idpBytes).digest('hex'), transformation: 'Contained test-provider import relocation' };
 // Base's default test supplies sibling source to its disposable compiler copy.
 // The standalone reference uses the same checks against its relocated source.
 const checks = 'foundation/template/tests/typecheck-checks.mjs', test = 'foundation/template/tests/incremental-typecheck.test.mjs';
 for (const [source, destination] of [[checks, 'tests/typecheck/typecheck-checks.mjs'], [test, 'tests/typecheck/incremental.test.mjs']]) {
  let bytes = await readFile(resolve(base, source), 'utf8');
  if (source === test) bytes = bytes.replace("resolve(import.meta.dirname, '..')", "resolve(import.meta.dirname, '../..')");
  await writeFile(resolve(target, destination), bytes);
  sources[destination] = { source, sha256: createHash('sha256').update(bytes).digest('hex'), transformation: 'Contained reference typecheck root relocation' };
 }
 const pkgPath = resolve(target, 'package.json'), pkg = JSON.parse(await readFile(pkgPath));
 delete pkg.dependencies['@run-edit-run/onboarding']; await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
 await writeFile(resolve(target, 'reference-export.json'), JSON.stringify({ version: 1, sources }, null, 2) + '\n');
}
if (process.argv[1] === import.meta.filename) {
 if (process.argv.length !== 3) throw Error('Usage: node scripts/export-reference.mjs NEW_PATH');
 await exportReference(resolve(import.meta.dirname, '..'), resolve(process.argv[2]));
}
