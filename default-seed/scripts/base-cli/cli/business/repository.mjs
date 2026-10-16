import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readPlainFile } from './files.mjs';

export async function repositoryBoundary(path, metadataOnly) {
 const marker = join(path, '.git');
 let info;
 try { info = await lstat(marker); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 if (info.isDirectory()) return 'repository';
 if (!info.isFile() || metadataOnly) return null;
 const pointer = (await readPlainFile(marker, info)).match(/^gitdir:[ \t]*(.+?)[ \t]*(?:\r?\n)?$/);
 if (!pointer) return null;
 // Inspect only the pointer's shape. Never follow it or emit its path.
 const gitdir = resolve(path, pointer[1]);
 return basename(dirname(gitdir)) === 'worktrees' ? 'linkedWorktree' : 'repository';
}
