import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const lockName = 'composition.lock.json';

export async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === '.git') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(directory, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsupported generated file: ${path}`);
  }
  return result.sort();
}

export async function validateTree(directory, edition, repository, expectedSha, base) {
  const lock = JSON.parse(await readFile(resolve(directory, lockName), 'utf8'));
  if (lock.schemaVersion !== 2 || lock.composition?.edition !== edition ||
      lock.repositories?.family?.repository !== repository ||
      !/^[a-f0-9]{40}$/.test(lock.repositories?.family?.commit ?? '') ||
      (expectedSha && lock.repositories.family.commit !== expectedSha) ||
      (base && (lock.repositories?.base?.repository !== base.repository || lock.repositories?.base?.commit !== base.commit)) ||
      !lock.files || Array.isArray(lock.files) || typeof lock.files !== 'object')
    throw new Error('Invalid composition lock identity');
  const expected = [...Object.keys(lock.files), lockName].sort();
  if (JSON.stringify(await files(directory)) !== JSON.stringify(expected))
    throw new Error('Tree differs from composition lock file inventory');
  for (const [path, record] of Object.entries(lock.files)) {
    const local = resolve(directory, path);
    const rel = relative(directory, local);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('.git'))
      throw new Error(`Unsafe lock path: ${path}`);
    const stat = await lstat(local);
    const hash = createHash('sha256').update(await readFile(local)).digest('hex');
    if (!stat.isFile() || hash !== record.sha256 || ![0o644, 0o755].includes(record.mode) ||
        (stat.mode & 0o111) !== (record.mode & 0o111))
      throw new Error(`Tree differs from composition lock: ${path}`);
  }
  return lock;
}

