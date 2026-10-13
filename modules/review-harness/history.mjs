import { mkdir, lstat, readFile, rename, readdir, rm, rmdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateFile } from './files.mjs';

const markerName = '.review-harness-owned.json';
async function inspect(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function owned(path, evidence) {
  const directory = await inspect(path);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return null;
  const marker = await inspect(join(path, markerName));
  if (!marker?.isFile() || marker.isSymbolicLink()) return null;
  try {
    const value = JSON.parse(await readFile(join(path, markerName), 'utf8'));
    if (value.owner === 'review-harness' && value.evidence === evidence && value.device === directory.dev && value.inode === directory.ino && Number.isFinite(value.createdAt)) return value;
  } catch { /* Unrecognized folders are never ours to rotate or prune. */ }
  return null;
}

// Own only directories we mkdir ourselves. Device/inode binding prevents a
// copied marker or a same-named foreign directory from authorizing deletion.
export async function prepareEvidence(path, historyLimit = 2) {
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) throw new TypeError('historyLimit must be a nonnegative integer');
  const evidence = resolve(path), parent = dirname(evidence), name = basename(evidence);
  if (evidence === parent) throw new TypeError('Evidence cannot be a filesystem root');
  await mkdir(parent, { recursive: true });
  const lock = join(parent, `.${name}.review-harness-lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Evidence directory is already in use; inspect its review-harness lock'); throw error; }
  try {
    const existing = await inspect(evidence);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Evidence must be a real directory');
      if (await owned(evidence, evidence)) {
        await rename(evidence, join(parent, `${name}.previous-${Date.now()}-${randomUUID()}`));
      } else if ((await readdir(evidence)).length) {
        throw new Error('Existing evidence is not owned by review-harness; choose a new directory');
      }
    }
    if (!(await inspect(evidence))) {
      await mkdir(evidence, { mode: 0o700 });
      const directory = await lstat(evidence);
      await privateFile(join(evidence, markerName), JSON.stringify({ owner: 'review-harness', evidence, device: directory.dev, inode: directory.ino, createdAt: Date.now() }) + '\n');
    }
    const previous = [];
    for (const file of await readdir(parent)) {
      if (!file.startsWith(`${name}.previous-`)) continue;
      const directory = join(parent, file), marker = await owned(directory, evidence);
      if (marker) previous.push({ directory, createdAt: marker.createdAt, inode: marker.inode, device: marker.device });
    }
    previous.sort((a, b) => b.createdAt - a.createdAt || b.directory.localeCompare(a.directory));
    for (const candidate of previous.slice(historyLimit)) {
      const current = await owned(candidate.directory, evidence);
      if (current?.inode === candidate.inode && current.device === candidate.device) await rm(candidate.directory, { recursive: true });
    }
    return { evidence, historyLimit, finish: () => rmdir(lock) };
  } catch (error) { await rmdir(lock); throw error; }
}
