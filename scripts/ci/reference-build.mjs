import { mkdir, readdir, lstat, realpath, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { referenceBuildIdentity, referenceBuildInventory } from '../../export/verify-app.mjs';

// Usage from the Base checkout: node scripts/ci/reference-build.mjs PATH
// PATH is a new directory outside the checkout. Upload that directory only;
// consumers set BASE_VERIFY_BUILD_ARTIFACT to the downloaded directory and
// retain CI_SOURCE_SHA, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT from this run.
export async function produceReferenceBuild(directory, { root = fileURLToPath(new URL('../../default-seed/', import.meta.url)), env = process.env } = {}) {
 root = await realpath(root);
 directory = resolve(directory);
 const checkout = resolve(root, '..');
 if (directory === checkout || directory.startsWith(checkout + '/')) throw Error('Reference build artifact must be outside the checkout');
 // CI contributes only execution context, never application or provider
 // credentials, to this build. rer build retains its own output guards.
 const buildEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI',
  'RER_JOBS_LOAD_THRESHOLD', 'RER_VERIFY_WORKERS'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
 Object.assign(buildEnv, { CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' });
 const identity = await referenceBuildIdentity(root, env);
 // Never open local private settings; a reference producer requires a clean
 // source checkout. These paths are checked by name and type only.
 for (const name of await readdir(root)) if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.rer|\.seed)$/.test(name)) throw Error('Reference build producer refuses local private settings');
 const dist = join(root, 'dist');
 const previous = await lstat(dist).catch(error => { if (error.code !== 'ENOENT') throw error; });
 if (previous?.isSymbolicLink() || previous && !previous.isDirectory()) throw Error('Unsafe reference build output directory');
 await mkdir(directory);
 let child, signal;
 const cancel = value => { signal ??= value; child?.kill(value); };
 const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT');
 process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
 try {
  await rm(dist, { recursive: true, force: true });
  if (signal) throw Error('Reference build interrupted');
  child = spawn('pnpm', ['run', 'build'], { cwd: root, env: buildEnv, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
   child.once('error', reject);
   child.once('close', code => resolve(code));
  });
  child = undefined;
  if (signal || code !== 0) throw Error('Reference build failed or was interrupted');
  const inventory = await referenceBuildInventory(root);
  if (JSON.stringify(identity) !== JSON.stringify(await referenceBuildIdentity(root, env))) throw Error('Reference build inputs changed while building');
  for (const path of inventory.directories) await mkdir(join(directory, path), { recursive: true });
  for (const { path } of inventory.files) {
   await mkdir(dirname(join(directory, path)), { recursive: true });
   await copyFile(join(root, path), join(directory, path));
  }
  if (signal || JSON.stringify(inventory) !== JSON.stringify(await referenceBuildInventory(directory))) throw Error('Reference build staging is incomplete');
  // Publishing the manifest last makes an interrupted artifact unusable.
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, identity, inventory }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Reference build artifact produced: ${inventory.files.length} files for ${identity.source}`);
 } catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
 } finally {
  process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 if (process.argv.length !== 3) throw Error('Usage: node scripts/ci/reference-build.mjs PATH');
 await produceReferenceBuild(process.argv[2]);
}
