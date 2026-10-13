import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { identityPattern } from './site-check.mjs';
const run = promisify(execFile);

// An identity is a public example only when the entire source file is the
// committed blob, unchanged in both index and working tree. Secrets never qualify.
export async function unpublishedIdentities(root, identities, privateFiles = []) {
 identities = [...new Set(identities)].filter(value => typeof value === 'string' && value.length);
 if (!identities.length) return [];
 const git = args => run('git', args, {cwd:root, maxBuffer:32 * 1024 * 1024, encoding:'buffer'});
 let paths, prefix;
 try {
  prefix = (await git(['rev-parse', '--show-prefix'])).stdout.toString().trim();
  paths = (await git(['ls-files', '--cached', '-z'])).stdout.toString().split('\0').filter(Boolean);
  await git(['rev-parse', '--verify', 'HEAD']);
 } catch (error) { if (error.code === 128) return identities; throw error; }
 const patterns = identities.map(identityPattern), published = new Set();
 for (const path of paths) {
  if (!/\.(?:[cm]?[jt]sx?|md|html|css|json|jsonc|toml|txt|ya?ml)$/.test(path) || path.split('/').some(part => part.startsWith('.')) || privateFiles.some(file => path === file || path.startsWith(file + '/'))) continue;
  const file = resolve(root, path), physical = await realpath(file).catch(() => null);
  if (!physical || relative(resolve(root), physical).split(sep).includes('..') || physical !== file) continue;
  const bytes = await readFile(file), text = bytes.toString('utf8');
  const matches = patterns.map(({pattern}, index) => !published.has(index) && pattern.test(text) ? index : -1).filter(index => index >= 0);
  if (!matches.length) continue;
  try {
   await git(['diff', '--quiet', 'HEAD', '--', path]);
   const indexed = (await git(['show', ':' + prefix + path])).stdout;
   const committed = (await git(['show', 'HEAD:' + prefix + path])).stdout;
   if (bytes.equals(indexed) && bytes.equals(committed)) for (const index of matches) published.add(index);
  } catch (error) { if (![1,128].includes(error.code)) throw error; }
 }
 return identities.filter((_, index) => !published.has(index));
}
