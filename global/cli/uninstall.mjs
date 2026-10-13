// rer cli uninstall: remove the user install (the launcher `rer cli install`
// wrote and the install root it runs), and nothing else. ~/.rer (servers, jobs,
// Node runtimes) is untouched, and so is any folder that is not a rer install
// root. An npm global rer leaves other channels' installs alone.
import { lstat, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installRecord, launcherOwner, layout } from './layout.mjs';
import { ownedPathLink } from './path-link.mjs';
import { channelOf } from './status.mjs';

// A folder `rer cli install` made: a versions/ directory and a `current` link into it.
async function installRoot(path) {
 try {
  if (!(await lstat(join(path, 'versions'))).isDirectory()) return false;
  return /^versions\/[^/]+$/.test(await readlink(join(path, 'current')));
 } catch { return false; }
}

export async function uninstall() {
 const paths = layout(), { channel } = await channelOf(paths), launcher = await launcherOwner(paths.launcher), lines = [];
 // The root the launcher runs; with no launcher, the layout's own root.
 const root = launcher.state === 'ours' && launcher.root ? launcher.root : paths.data;
 const user = launcher.state === 'ours' || await installRoot(root);
 if (channel === 'npm-global') {
  lines.push('This rer came from npm; remove it with: npm uninstall -g @runeditrun/rer');
  if (user) lines.push(`A user install is also present${launcher.state === 'ours' ? ` (${paths.launcher})` : ` (${root})`}; remove it with: ${launcher.state === 'ours' ? paths.launcher : 'npx -y @runeditrun/rer'} cli uninstall`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
 }
 for (const link of (await installRecord(paths))?.links ?? []) {
  if (await ownedPathLink(link, paths.launcher)) { await rm(link); lines.push(`Removed ${link}.`); }
 }
 if (launcher.state === 'ours') { await rm(paths.launcher); lines.push(`Removed ${paths.launcher}.`); }
 else if (launcher.state === 'foreign') lines.push(`Left ${paths.launcher} in place: rer cli install did not write it.`);
 if (await installRoot(root)) { await rm(root, { recursive: true, force: true }); lines.push(`Removed ${root}.`); }
 else if (launcher.state === 'ours') lines.push(`Left ${root} in place: it is not a rer install root.`);
 if (!lines.length) lines.push('No user install of rer was found; nothing changed.');
 process.stdout.write(lines.join('\n') + '\n');
 return 0;
}
