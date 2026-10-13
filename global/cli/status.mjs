// rer cli status: what this rer is and every other rer on PATH.
import { access, constants, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ownManifest, ownRoot, packageDigest } from '../package-info.mjs';
import { installRecord, launcherOwner, layout } from './layout.mjs';

const inside = (path, root) => path === root || path.startsWith(root + sep);
async function real(path) { try { return await realpath(path); } catch { return undefined; } }

export async function channelOf(paths) {
 const data = await real(paths.data);
 if (data && inside(ownRoot, join(data, 'versions'))) return { channel: (await installRecord(paths))?.channel ?? 'npx', root: data };
 if (ownRoot.split(sep).includes('_npx')) return { channel: 'npx', root: ownRoot };
 if (ownRoot.endsWith(join('node_modules', '@runeditrun', 'rer'))) return { channel: 'npm-global', root: ownRoot };
 return { channel: 'source', root: ownRoot };
}

// Every executable `rer` on PATH except the ones that run this very install.
export async function pathCommands(installRoot, env = process.env) {
 const seen = new Set(), self = [], others = [];
 for (const directory of (env.PATH ?? '').split(':').filter(Boolean)) {
  const candidate = resolve(directory, 'rer');
  if (seen.has(candidate)) continue;
  seen.add(candidate);
  try { await access(candidate, constants.X_OK); } catch { continue; }
  const target = await real(candidate);
  const launcher = await launcherOwner(target ?? candidate);
  if (target && inside(target, ownRoot) || launcher.state === 'ours' && launcher.root && await real(launcher.root) === installRoot) self.push(candidate);
  else others.push(candidate);
 }
 return { self, others };
}

export async function status({ json }) {
 const paths = layout(), manifest = ownManifest(), { channel, root } = await channelOf(paths);
 const launcher = await launcherOwner(paths.launcher), commands = await pathCommands(root);
 const result = {
  version: manifest.version,
  digest: await packageDigest(ownRoot),
  channel,
  launcher: channel === 'npm-global' ? commands.self[0] ?? null : launcher.state === 'ours' ? paths.launcher : null,
  root,
  others: commands.others,
 };
 if (json) process.stdout.write(JSON.stringify(result) + '\n');
 else process.stdout.write([
  `rer ${result.version} (${result.channel})`,
  `digest:   ${result.digest}`,
  `root:     ${result.root}`,
  `launcher: ${result.launcher ?? '(none)'}`,
  `others on PATH: ${result.others.length ? '\n  ' + result.others.join('\n  ') : '(none)'}`,
 ].join('\n') + '\n');
 return 0;
}
