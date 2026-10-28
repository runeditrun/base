import { readFile, readdir, lstat, mkdir, copyFile, rm, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, dirname, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const fail = message => { throw Error(`Reference build artifact: ${message}`); };
const digest = value => createHash('sha256').update(value).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const portable = path => path.split(/[\\/]/).join('/');

async function installedTool(parent, name) {
 let directory = dirname(createRequire(await realpath(parent)).resolve(name));
 while (true) {
  const path = join(directory, 'package.json');
  const bytes = await readFile(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (bytes) {
   const value = JSON.parse(bytes);
   if (value.name === name) return { version: value.version, sha256: digest(bytes) };
  }
  const next = dirname(directory);
  if (next === directory) fail(`cannot identify installed tool: ${name}`);
  directory = next;
 }
}

function output(command, args, cwd, env) {
 const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
 if (result.error || result.status !== 0) fail(`${command} could not verify the build inputs`);
 return result.stdout.trim();
}

// The producer and every consumer measure their own installed tools. Manifest
// declarations alone cannot establish what actually performed the build.
export async function referenceBuildIdentity(root, env = process.env) {
 root = await realpath(root);
 const source = env.CI_SOURCE_SHA;
 if (!/^[a-f0-9]{40}$/.test(source ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail('source SHA, run and attempt are required');
 const checkout = output('git', ['rev-parse', '--show-toplevel'], root, env);
 if (output('git', ['rev-parse', 'HEAD'], root, env) !== source) fail('checkout does not match the expected source SHA');
 output('git', ['diff', '--quiet', 'HEAD', '--'], checkout, env);
 const declaration = await readJSON(join(root, 'package.json'));
 if (['WORKERD_BINARY_PATH', 'ESBUILD_BINARY_PATH', 'ROLLDOWN_BINDING_PATH'].some(key => env[key])) fail('external toolchain overrides are not reusable');
 if (declaration.engines?.node !== process.versions.node) fail('actual Node does not match the declared runtime');
 const pnpm = output('pnpm', ['--version'], root, env);
 if (declaration.packageManager !== `pnpm@${pnpm}`) fail('actual pnpm does not match the declared package manager');
 // This validates the frozen graph without downloading packages or running any
 // install scripts. The normal CI bootstrap already installed dependencies.
 output('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--offline', '--ignore-scripts'], root, env);
 const tracked = output('git', ['ls-files', '-z'], checkout, env).split('\0').filter(Boolean);
 const inputs = {};
 for (const path of tracked.filter(path => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)).sort()) {
  inputs[path] = digest(await readFile(join(checkout, path)));
 }
 if (!inputs[portable(relative(checkout, join(root, 'pnpm-lock.yaml')))] || !inputs['pnpm-lock.yaml']) fail('tracked frozen lockfiles are required');
 const packages = {};
 for (const [name, expected] of Object.entries({ ...declaration.dependencies, ...declaration.devDependencies }).sort(([a], [b]) => a.localeCompare(b))) {
  const bytes = await readFile(join(root, 'node_modules', name, 'package.json'));
  const installed = JSON.parse(bytes);
  if (installed.name !== name || installed.version !== expected) fail(`installed package differs from its declaration: ${name}`);
  packages[name] = { version: installed.version, sha256: digest(bytes) };
 }
 for (const [parent, name] of [['wrangler', 'workerd'], ['wrangler', 'miniflare'], ['wrangler', 'esbuild'], ['vite', 'rolldown']]) {
  packages[`${parent}>${name}`] = await installedTool(join(root, 'node_modules', parent, 'package.json'), name);
 }
 output('git', ['diff', '--quiet', 'HEAD', '--'], checkout, env);
 return { source, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
  project: portable(relative(checkout, root)), inputs,
  toolchain: { node: process.versions.node, nodeSHA256: digest(await readFile(process.execPath)), pnpm, platform: process.platform, arch: process.arch, packages } };
}

const privatePart = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.git|\.wrangler|\.seed|\.rer|node_modules|exports|secrets?(?:\..*)?|credentials?(?:\..*)?|settings(?:\..*)?)$/i;
const extensions = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.svg', '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.txt', '.sql', '.map', '.webmanifest', '.xml']);
function reviewPath(path, directory) {
 const parts = path.split('/');
 if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || privatePart.test(part))) fail('private or unsafe output path');
 if (path !== 'dist' && !/^dist\/(?:client|server)(?:\/|$)/.test(path)) fail('unexpected output root');
 const hidden = parts.filter(part => part.startsWith('.'));
 if (hidden.length && !(hidden.length === 1 && (parts.at(-1) === '.assetsignore' || /^dist\/(?:client|server)\/\.vite(?:\/(?:ssr-)?manifest\.json)?$/.test(path)))) fail('unreviewed hidden output');
 if (!directory && !extensions.has(extname(path)) && parts.at(-1) !== '.assetsignore') fail('unreviewed output type');
}

async function fileDigest(path) {
 const hash = createHash('sha256');
 let tail = '';
 for await (const chunk of createReadStream(path)) {
  hash.update(chunk);
  const text = tail + chunk.toString('utf8');
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /"format"\s*:\s*"runeditrun-portability"/.test(text)) fail('private material in build output');
  tail = text.slice(-512);
 }
 return hash.digest('hex');
}

// Inventory includes directories as well as every byte of every file. Neither
// a partially downloaded tree nor additional files can satisfy this manifest.
export async function referenceBuildInventory(root) {
 const directories = [], files = [];
 async function visit(path) {
  const absolute = join(root, path), status = await lstat(absolute);
  if (status.isSymbolicLink() || !status.isFile() && !status.isDirectory()) fail('outputs must be regular files and directories');
  reviewPath(path, status.isDirectory());
  if (status.isDirectory()) {
   directories.push(path);
   for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`);
  } else files.push({ path, size: status.size, sha256: await fileDigest(absolute) });
 }
 await visit('dist');
 const names = new Set(files.map(file => file.path));
 if (!names.has('dist/server/wrangler.json') || !names.has('dist/client/reference/index.html')
   || !files.some(file => file.path.startsWith('dist/client/assets/') && file.path.endsWith('.js'))
   || !names.has('dist/server/.vite/manifest.json')) fail('incomplete Worker, client or prerender output');
 const config = await readJSON(join(root, 'dist/server/wrangler.json'));
 if (typeof config.main !== 'string' || isAbsolute(config.main) || config.main.includes('\\')
   || !names.has(portable(relative(root, resolve(root, 'dist/server', config.main))))
   || !resolve(root, 'dist/server', config.main).startsWith(resolve(root, 'dist/server') + '/')) fail('invalid emitted Worker entry');
 if (typeof config.assets?.directory !== 'string' || isAbsolute(config.assets.directory)
   || resolve(root, 'dist/server', config.assets.directory) !== resolve(root, 'dist/client')
   || config.assets.run_worker_first !== true || config.assets.binding !== 'ASSETS') fail('emitted assets do not preserve hosted routing');
 if (Object.keys(config.vars ?? {}).length || config.account_id || config.env || config.secrets) fail('emitted Worker config contains private settings');
 return { directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function restoreReferenceBuild(root, artifact, env = process.env) {
 root = await realpath(root);
 artifact = resolve(artifact);
 const status = await lstat(artifact);
 if (!status.isDirectory() || status.isSymbolicLink() || artifact === root || artifact === join(root, 'dist') || artifact.startsWith(join(root, 'dist') + '/')) fail('unsafe artifact directory');
 if (!equal((await readdir(artifact)).sort(), ['dist', 'manifest.json'])) fail('unexpected artifact contents');
 const manifestStatus = await lstat(join(artifact, 'manifest.json'));
 if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()) fail('unsafe artifact manifest');
 const manifest = await readJSON(join(artifact, 'manifest.json'));
 if (!equal(Object.keys(manifest).sort(), ['identity', 'inventory', 'version']) || manifest.version !== 1) fail('unsupported manifest');
 if (!equal(manifest.identity, await referenceBuildIdentity(root, env))) fail('stale source, run, frozen lock or actual toolchain');
 const inventory = await referenceBuildInventory(artifact);
 if (!equal(inventory, manifest.inventory)) fail('output inventory or digest mismatch');
 // Only the reviewed output tree is replaced. Local state, installation,
 // recovery and tests that build for themselves keep their usual flows.
 const destination = join(root, 'dist');
 const previous = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
 if (previous?.isSymbolicLink() || previous && !previous.isDirectory()) fail('unsafe existing output directory');
 await rm(destination, { recursive: true, force: true });
 for (const path of inventory.directories) await mkdir(join(root, path), { recursive: true });
 for (const { path } of inventory.files) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await copyFile(join(artifact, path), join(root, path));
 }
 if (!equal(await referenceBuildInventory(root), inventory)) fail('restored outputs differ from the artifact');
 console.log(`Reference build artifact validated for ${manifest.identity.source}`);
}

export async function verificationPlan() {
 const plan = JSON.parse(await readFile(new URL('../verification.json', import.meta.url), 'utf8'));
 const names = new Set();
 for (const tier of ['push', 'nightly']) {
  if (!Array.isArray(plan[tier])) throw Error(`Missing verification tier: ${tier}`);
  for (const shard of plan[tier]) {
   if (!/^[a-z][a-z0-9-]*$/.test(shard.name) || names.has(shard.name)) throw Error(`Invalid or duplicate shard: ${shard.name}`);
   if (typeof shard.browser !== 'boolean' || typeof shard.hosted !== 'boolean' || !Array.isArray(shard.commands) || !shard.commands.length || shard.commands.some(command => typeof command !== 'string' || !command.trim())) throw Error(`Incomplete shard: ${shard.name}`);
   names.add(shard.name);
  }
 }
 if (!plan.push.length || plan.push.filter(shard => shard.hosted).length !== 1) throw Error('Push verification must include the hosted production build');
 return plan;
}

export function run(command, env = process.env) {
 console.log(`> ${command}`);
 const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', command], { stdio: 'inherit', env });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] === import.meta.filename) {
 const plan = await verificationPlan();
 const all = [...plan.push, ...plan.nightly];
 const selected = process.env.SEED_VERIFY_SHARD;
 const shards = selected ? all.filter(shard => shard.name === selected) : all;
 if (!shards.length) throw Error(`Unknown verification shard: ${selected}`);
 const artifact = process.env.BASE_VERIFY_BUILD_ARTIFACT;
 if (artifact && shards.some(shard => shard.commands.includes('pnpm run build'))) {
  await restoreReferenceBuild(fileURLToPath(new URL('../', import.meta.url)), artifact);
 }
 for (const shard of shards) for (const command of shard.commands) {
  if (artifact && command === 'pnpm run build') console.log('> pnpm run build (validated reference artifact)');
  else run(command);
 }
}
