import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

// Caller-named roots are canonicalized once; below them, refuse symlink
// ancestors as well as symlink entries before reading any file content.
async function plainAncestors(path) {
 const root = parse(path).root;
 let current = root;
 for (const part of path.slice(root.length).split('/').filter(Boolean)) {
  current = join(current, part);
  if ((await lstat(current)).isSymbolicLink()) return false;
 }
 return true;
}

export async function readPlainFile(path, info) {
 // O_NOFOLLOW blocks a replaced leaf; compare the opened inode before reading.
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const opened = await file.stat();
  if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || !await plainAncestors(dirname(path))) throw Error('Changed scan input');
  return await file.readFile('utf8');
 } finally { await file.close(); }
}
