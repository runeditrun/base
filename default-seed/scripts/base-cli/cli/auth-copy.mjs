import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { contained } from './project.mjs';

// SC-05.auth-copy: the operator-auth layers a seed copied from Base stay the
// bytes of the Base revision it pinned. A seed records its copies in
// base-copies.json (edition authoring) or composition.lock.json /
// foundation.lock.json (composed foundations); each records the SHA-256 of the
// Base bytes it copied. Application runtime and schema sources share one pin;
// the CLI's bundled tooling has its own. Numbered SQL under migrations keeps
// its historical revision independently: refreshing runtime must not rewrite
// SQL a database may already have applied. Adaptations retain their original
// pin and compare local bytes/mode with their explicit acknowledgement.
// A seed that imports Base in place has no copy.
const ORIGIN = 'modules/operator-auth';
const CLI_ROOT = 'scripts/base-cli';
const within = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
const groupOf = path => typeof path === 'string' && within(path, CLI_ROOT) ? 'cli'
 : /(?:^|\/)migrations\/(?:[^/]+\/)*\d+[^/]*\.sql$/.test(path) ? 'migration' : 'application';
const pinned = revision => typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function json(root, path) { try { return JSON.parse(await readFile(await contained(root, path), 'utf8')); } catch { return null; } }

// Every file under a copied directory, so an added file is named too.
async function walk(root, path) {
 let stat; try { stat = await lstat(await contained(root, path)); } catch { return []; }
 if (stat.isFile()) return [path];
 if (!stat.isDirectory()) return [path];
 const files = [];
 for (const entry of await readdir(join(root, path), { withFileTypes: true })) files.push(...await walk(root, `${path}/${entry.name}`));
 return files;
}

// [{ path, revision, files: { local path: sha256 } }] for every recorded auth copy.
async function recordedCopies(root) {
 const copies = [];
 const record = await json(root, 'base-copies.json');
 for (const copy of record?.copies ?? []) {
  if (typeof copy?.originPath !== 'string' || !within(copy.originPath, ORIGIN)) continue;
  const files = copy.files && typeof copy.files === 'object' && !Array.isArray(copy.files) ? copy.files : {};
  copies.push({ path: copy.path, revision: copy.revision, files, adapted: copy.adapted, acknowledged: copy.acknowledged, directory: copy.originPath === ORIGIN || Object.keys(files).some(path => path !== copy.path && within(path, copy.path)) });
 }
 for (const name of ['composition.lock.json', 'foundation.lock.json']) {
  const lock = await json(root, name);
  if (!lock?.files) continue;
  const revision = lock.repositories?.base?.commit ?? lock.base?.commit;
  for (const cli of [false, true]) {
   const entries = Object.entries(lock.files).filter(([path, file]) => (groupOf(path) === 'cli') === cli && typeof file?.source === 'string' && within(file.source, ORIGIN));
   const files = Object.fromEntries(entries.map(([path, file]) => [path, file.sha256]));
   const directories = [...new Set(entries.filter(([, file]) => !file.source.endsWith('.sql')).map(([path, file]) => path.slice(0, path.length - (file.source.length - ORIGIN.length))))];
   if (Object.keys(files).length) copies.push({ path: directories[0] ?? null, revision, files, directory: directories.length === 1 });
  }
 }
 return copies;
}

export async function authCopyClauses(root) {
 const copies = await recordedCopies(root);
 if (!copies.length) return [];
 const clauses = [];
 for (const [group, id, scope] of [['application', 'SC-05.auth-copy.pin', 'the application runtime and schema sources'], ['cli', 'SC-05.auth-copy.cli-pin', `the CLI's bundled copy under ${CLI_ROOT}`]]) {
  const grouped = copies.filter(copy => Object.keys(copy.files).some(path => groupOf(path) === group && !Object.hasOwn(copy.adapted ?? {}, path)));
  if (!grouped.length) continue;
  const revisions = [...new Set(grouped.map(copy => copy.revision))];
  clauses.push([id, revisions.length === 1 && pinned(revisions[0]), `Copy ${scope} of operator-auth from one pinned Base revision; the seed records ${revisions.join(', ') || 'none'}.`]);
 }
 for (const copy of copies) {
  if (!Object.keys(copy.files).length) clauses.push([`SC-05.auth-copy.${copy.path}`, false, `${copy.path} has no recorded bytes; record its copied files and their SHA-256 digests.`]);
  for (const [path, expected] of Object.entries(copy.files)) {
   const adapted = Object.hasOwn(copy.adapted ?? {}, path), revision = adapted ? copy.adapted[path] : copy.revision;
   if (groupOf(path) === 'migration') clauses.push([`SC-05.auth-copy.migration-pin.${path}`, pinned(revision), `${path} must retain a valid pinned Base revision for its historical SQL; the seed records ${revision ?? 'none'}.`]);
   let actual = null, mode = null;
   try {
    const file = await contained(root, path), status = await lstat(file);
    if (status.isFile()) { actual = sha256(await readFile(file)); mode = status.mode & 0o100 ? '100755' : '100644'; }
   } catch {}
   if (adapted) {
    const accepted = copy.acknowledged?.[path];
    clauses.push([`SC-05.auth-copy.adaptation-pin.${path}`, pinned(revision) && digest(expected), `${path} must retain its original Base revision and digest as the adaptation baseline.`]);
    clauses.push([`SC-05.auth-copy.${path}`, actual !== null && digest(accepted?.sha256) && ['100644', '100755'].includes(accepted?.mode) && actual === accepted.sha256 && mode === accepted.mode,
     `${path} must match its acknowledged local bytes and mode; review it, then run adapt-base ${path}. Keep applied migration bytes and put schema changes in a new migration.`]);
    continue;
   }
   clauses.push([`SC-05.auth-copy.${path}`, actual !== null && actual === expected, actual === null
    ? `${path} is missing; restore it from Base ${copy.revision}.`
    : groupOf(path) === 'migration'
     ? `${path} differs from Base ${copy.revision}; restore its historical bytes and put schema changes in a new migration.`
     : `${path} differs from Base ${copy.revision}; restore the copied bytes or record a new pin with refresh-base.`]);
  }
  if (copy.directory && copy.path) {
   for (const path of await walk(root, copy.path)) {
    if (!Object.hasOwn(copy.files, path) && !path.split('/').some(part => ['tests', 'node_modules', '.DS_Store'].includes(part))) {
     clauses.push([`SC-05.auth-copy.${path}`, false, `${path} is not part of Base ${copy.revision}'s operator-auth; remove it or keep seed code outside the copied layers.`]);
    }
   }
  }
 }
 return clauses;
}
