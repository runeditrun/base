import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const descriptor = '.rer-demo-template.json';
const initialized = '.rer-demo-initialized.json';
const copying = '.rer-demo-initializing.json';

async function inventory(directory, prefix = '') {
 const entries = [];
 for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isFile() && !entry.isDirectory()) throw new Error('demo-template-invalid-entry');
  const path = prefix + entry.name;
  entries.push({ path, directory: entry.isDirectory() });
  if (entry.isDirectory()) entries.push(...await inventory(join(directory, entry.name), path + '/'));
 }
 return entries;
}

/** Called only after the engine has closed its database and persistence files. */
export async function sealTemplate(template, manifest) {
 const entries = await inventory(template);
 if (entries.some(entry => ['host.lock', descriptor, initialized, copying].includes(entry.path))) throw new Error('demo-template-not-fresh');
 const marker = { version: 1, manifest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), entries };
 await writeFile(join(template, descriptor), JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
 return marker;
}

async function present(directory, entries) {
 for (const entry of entries) {
  let stat;
  try { stat = await lstat(join(directory, entry.path)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (entry.directory ? !stat.isDirectory() : !stat.isFile()) return false;
 }
 return true;
}

/** Caller holds data/host.lock until the host exits. Never overlays live data. */
export async function copyTemplate(template, data) {
 const raw = await readFile(join(template, descriptor), 'utf8'), marker = JSON.parse(raw);
 if (marker.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.manifest ?? '') || !Array.isArray(marker.entries)
  || marker.entries.some(entry => typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/')
   || entry.path.split('/').some(part => ['', '.', '..'].includes(part)) || typeof entry.directory !== 'boolean'
   || [descriptor, initialized, copying, 'host.lock'].includes(entry.path))) throw new Error('demo-template-invalid');
 await mkdir(data, { recursive: true, mode: 0o700 });
 const existing = await readdir(data);
 if (existing.includes('host.lock') && !(await lstat(join(data, 'host.lock'))).isFile()) throw new Error('demo-volume-invalid-lock');
 if (existing.includes(copying)) throw new Error('demo-volume-incomplete');
 if (existing.includes(initialized)) {
  if (!(await lstat(join(data, initialized))).isFile()) throw new Error('demo-volume-incomplete');
  if (await readFile(join(data, initialized), 'utf8') !== raw) throw new Error('demo-volume-template-mismatch');
  // SQLite may remove its transient WAL/SHM files after a later clean close.
  if (!await present(data, marker.entries.filter(entry => !/-(wal|shm)$/.test(entry.path)))) throw new Error('demo-volume-incomplete');
  return { copied: false };
 }
 if (existing.some(name => name !== 'host.lock')) throw new Error('demo-volume-not-fresh');
 if (!await present(template, marker.entries)) throw new Error('demo-template-incomplete');
 await writeFile(join(data, copying), raw, { flag: 'wx', mode: 0o600 });
 for (const entry of marker.entries.filter(entry => !entry.path.includes('/'))) {
  await cp(join(template, entry.path), join(data, entry.path), { recursive: true, force: false, errorOnExist: true });
 }
 if (!await present(data, marker.entries)) throw new Error('demo-volume-incomplete');
 await rename(join(data, copying), join(data, initialized));
 return { copied: true };
}

if (process.argv[1] === import.meta.filename) {
 try { await copyTemplate(process.argv[2] ?? '/template', process.argv[3] ?? '/data'); }
 catch (error) { console.error('Demo volume initialization failed:', error.message); process.exitCode = 1; }
}
