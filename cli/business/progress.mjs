import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from './state.mjs';

export async function loadProgress() {
 try { return JSON.parse(await readFile(join(stateDirectory(), 'progress.json'), 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function saveProgress(progress) {
 const directory = stateDirectory();
 await mkdir(directory, { recursive: true, mode: 0o700 });
 const temporary = join(directory, `${randomUUID()}.tmp`);
 try {
  await writeFile(temporary, JSON.stringify(progress), { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(directory, 'progress.json'));
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
