import { execFileSync } from 'node:child_process';
import { refuse } from './errors.mjs';
import { deployAgain } from './deploy-inputs.mjs';

// rer deploy publishes the checkout's last commit: the deploy identity names it.
// Say so before any build or upload, naming the tracked files that differ.
export function committedSource(root, options) {
 const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
 const again = deployAgain(options);
 let status, sha;
 try { status = git('status', '--porcelain', '-z', '--untracked-files=no'); sha = git('rev-parse', 'HEAD').trim(); }
 catch { throw refuse(`rer deploy publishes the checkout's last Git commit, and this checkout has none. Commit the source with Git, then run ${again} again. Nothing was uploaded.`); }
 const entries = status.split('\0'), paths = [];
 for (let index = 0; index < entries.length; index++) {
  if (!entries[index]) continue;
  paths.push(entries[index].slice(3));
  // A rename or copy is followed by its original path.
  if (/^([RC].|.[RC])/.test(entries[index])) index++;
 }
 if (!paths.length) return sha;
 const shown = paths.slice(0, 20).map(path => `  ${path}`);
 if (paths.length > shown.length) shown.push(`  and ${paths.length - shown.length} more`);
 throw refuse(`Deploy stopped before building: these tracked files have changes that are not committed:\n${shown.join('\n')}\nrer deploy publishes the last commit. Commit the changes (for example git commit -am "Describe the change") or discard them, then run ${again} again. Nothing was uploaded.`);
}
