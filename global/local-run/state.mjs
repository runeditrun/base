import { constants } from 'node:fs';
import { chmod, cp, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { privateDirectory } from '../../onboarding/local/files.mjs';
import { resolveProject } from '../../cli/project.mjs';
import { failure } from './error.mjs';
import { stateManifest, validBackupName } from './state-manifest.mjs';

export const upgradeDirectory = checkout => join(checkout, '.rer/upgrade');
export async function secureDirectory(checkout, directory) {
 await privateDirectory(checkout, directory);
 await chmod(directory, 0o700);
}
export async function readJSON(path) {
 try {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || process.getuid && status.uid !== process.getuid()) throw failure('refused');
  return JSON.parse(await readFile(path, 'utf8'));
 } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeJSON(checkout, path, value) {
 await secureDirectory(checkout, join(path, '..'));
 const temporary = `${path}.${process.pid}.tmp`;
 const file = await open(temporary, 'wx', 0o600);
 try {
  try {
   await file.writeFile(JSON.stringify(value, null, 2) + '\n');
   await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  const parent = await open(join(path, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
 }
 finally { await rm(temporary, { force: true }); }
}
async function safeParents(checkout, directory) {
 let current = checkout;
 for (const part of relative(checkout, directory).split('/').filter(Boolean)) {
  current = join(current, part);
  const status = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!status) return;
  if (!status.isDirectory() || status.isSymbolicLink() || process.getuid && status.uid !== process.getuid()) throw failure('refused');
 }
}
export async function readJournal(checkout) {
 await safeParents(checkout, upgradeDirectory(checkout));
 return readJSON(join(upgradeDirectory(checkout), 'journal.json'));
}
export const writeJournal = (checkout, value) => writeJSON(checkout, join(upgradeDirectory(checkout), 'journal.json'), value);

// Refuse linked/foreign state before copying or opening any SQLite file.
async function safeTree(checkout, path, files = []) {
 let status;
 try { status = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
 if (status.isSymbolicLink() || process.getuid && status.uid !== process.getuid() || !status.isDirectory() && (!status.isFile() || status.nlink !== 1)) throw failure('database_failed');
 if (status.isDirectory()) for (const name of await readdir(path)) await safeTree(checkout, join(path, name), files);
 else files.push(relative(checkout, path));
 return files;
}
export async function localPaths(checkout) {
 const project = await resolveProject(checkout);
 const settings = project.adapter?.settings ?? [];
 if (!Array.isArray(settings) || settings.some(path => typeof path !== 'string' || !/^\.dev\.vars(?:\.previous)?$|^data\/[a-zA-Z0-9_-]+\.json$/.test(path))) throw failure('database_failed');
 const paths = [...new Set(['.wrangler/state', '.rer/local', '.seed/installer', ...settings])];
 for (const path of paths) {
  await safeParents(checkout, join(checkout, path, '..'));
  await safeTree(checkout, join(checkout, path));
 }
 return paths;
}
export async function rowCounts(checkout) {
 const files = await safeTree(checkout, join(checkout, '.wrangler/state'));
 const databases = files.filter(path => /(?:^|\/)d1\//.test(path) && /\.sqlite$/.test(path));
 const { DatabaseSync } = await import('node:sqlite');
 const result = {};
 for (const file of databases) {
  const db = new DatabaseSync(join(checkout, file), { readOnly: true });
  try {
   db.exec('PRAGMA busy_timeout=10000');
   const tables = {};
   for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const statement = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`);
    statement.setReadBigInts(true);
    tables[name] = statement.get().n.toString();
   }
   result[file] = tables;
  } finally { db.close(); }
 }
 return result;
}
export function checkPriorData(before, after, allowed = []) {
 for (const [file, tables] of Object.entries(before)) for (const [table, count] of Object.entries(tables)) {
  if (allowed.includes(table)) continue;
  if (!Object.hasOwn(after[file] ?? {}, table) || BigInt(after[file][table]) < BigInt(count)) throw failure('prior_data_changed');
 }
}
export async function snapshot(checkout, metadata) {
 const parent = join(upgradeDirectory(checkout), 'backups');
 await secureDirectory(checkout, parent);
 const journal = await readJournal(checkout), backups = [];
 for (const entry of await readdir(parent, { withFileTypes: true })) {
  const { name } = entry;
  // Unrecognised names are not ours to inspect or prune.
  if (!entry.isDirectory() || !validBackupName(name)) continue;
  await safeParents(checkout, join(parent, name));
  const saved = await readJSON(join(parent, name, 'backup.json'));
  if (saved?.name === name) backups.push({ name, sequence: Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence : 0 });
 }
 const sequence = backups.reduce((latest, backup) => Math.max(latest, backup.sequence), 0) + 1;
 if (!Number.isSafeInteger(sequence)) throw failure('database_failed');
 // Reserve a new directory even when a process takes two snapshots in the
 // same millisecond. Names remain valid recovery names; ordering uses sequence.
 let name, directory, instant = Date.now();
 for (;;) {
  name = new Date(instant++).toISOString().replace(/[^0-9TZ]/g, '') + `-${process.pid}`;
  directory = join(parent, name);
  try { await mkdir(directory, { mode: 0o700 }); break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
 }
 const paths = await localPaths(checkout), components = {};
 for (const path of paths) {
  components[path] = await stateManifest(join(checkout, path));
  if (components[path] === null) continue;
  await mkdir(join(directory, 'state', path, '..'), { recursive: true, mode: 0o700 });
  await cp(join(checkout, path), join(directory, 'state', path), { recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true });
 }
 for (const path of paths) if (JSON.stringify(await stateManifest(join(directory, 'state', path))) !== JSON.stringify(components[path])) throw failure('database_failed');
 await writeJSON(checkout, join(directory, 'backup.json'), { ...metadata, paths, name, components, sequence });
 // Publish metadata only after every state byte has arrived. Incomplete copies
 // are never restore candidates and never displace a completed backup.
 const keep = new Set([name, ...backups.filter(saved => saved.name === journal?.backup).map(saved => saved.name)]);
 for (const saved of backups.sort((a, b) => b.sequence - a.sequence || a.name.localeCompare(b.name))) {
  if (keep.size < 2) keep.add(saved.name);
  if (!keep.has(saved.name)) await rm(join(parent, saved.name), { recursive: true });
 }
 return name;
}
export async function backup(checkout, name) {
 if (!validBackupName(name)) throw failure('refused');
 const directory = join(upgradeDirectory(checkout), 'backups', name);
 await safeParents(checkout, directory);
 await safeTree(checkout, directory);
 const metadata = await readJSON(join(directory, 'backup.json'));
 if (!metadata || metadata.name !== name || !/^[a-f0-9]{40}$/.test(metadata.head) || !Array.isArray(metadata.paths)) throw failure('refused');
 for (const path of metadata.paths) if (!['.wrangler/state', '.rer/local', '.seed/installer'].includes(path) && !/^\.dev\.vars(?:\.previous)?$|^data\/[a-zA-Z0-9_-]+\.json$/.test(path)) throw failure('refused');
 if (!metadata.components || typeof metadata.components !== 'object' || Array.isArray(metadata.components) ||
  metadata.paths.length !== new Set(metadata.paths).size ||
  Object.keys(metadata.components).length !== metadata.paths.length ||
  !['.wrangler/state', '.rer/local', '.seed/installer'].every(path => metadata.paths.includes(path))) throw failure('refused');
 for (const path of metadata.paths) {
  if (!Object.hasOwn(metadata.components, path) ||
   JSON.stringify(await stateManifest(join(directory, 'state', path))) !== JSON.stringify(metadata.components[path])) throw failure('refused');
 }
 return { directory, metadata };
}
export async function restoreState(checkout, name) {
 const { directory, metadata } = await backup(checkout, name);
 // Validate every live destination and saved component before the first removal.
 for (const path of metadata.paths) {
  await safeParents(checkout, join(checkout, path, '..'));
  await safeTree(checkout, join(checkout, path));
 }
 for (const path of metadata.paths) {
  await rm(join(checkout, path), { recursive: true, force: true });
  const saved = join(directory, 'state', path);
  if (metadata.components[path] === null) continue;
  await mkdir(join(checkout, path, '..'), { recursive: true, mode: 0o700 });
  await cp(saved, join(checkout, path), { recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true });
 }
 return metadata;
}
