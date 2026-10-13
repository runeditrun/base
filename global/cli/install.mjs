// rer cli install: copy the running package's own bytes into an immutable
// version directory, switch `current` atomically, keep the previous version,
// prune older ones and write the launcher. Never edits shell profiles.
import { randomUUID } from 'node:crypto';
import { access, constants, chmod, cp, mkdir, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ownManifest, ownRoot, packageDigest, packageFileList } from '../package-info.mjs';
import { installRecord, launcherOwner, launcherScript, layout } from './layout.mjs';
import { exposeLauncher } from './path-link.mjs';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';
import { runningDoor } from '../../cli/door.mjs';

async function readLink(path) { try { return await readlink(path); } catch (error) { if (['ENOENT', 'EINVAL'].includes(error.code)) return undefined; throw error; } }

// Files read-only (immutable by intent); directories stay removable for pruning.
async function freeze(root) {
 for (const path of await packageFileList(root)) await chmod(join(root, path), path.endsWith('global/rer.mjs') || path === 'bin/rer.mjs' ? 0o555 : 0o444);
}

async function copyVersion(paths, name) {
 const staging = join(paths.versions, `.staging-${randomUUID()}`);
 await mkdir(paths.versions, { recursive: true });
 try {
  await cp(ownRoot, staging, { recursive: true });
  await freeze(staging);
  await rename(staging, join(paths.versions, name));
 } finally { await rm(staging, { recursive: true, force: true }); }
}

async function switchCurrent(paths, name) {
 const temporary = `${paths.current}.${randomUUID()}`;
 await symlink(join('versions', name), temporary);
 await rename(temporary, paths.current);
}

async function writeLauncher(paths) {
 await mkdir(paths.bin, { recursive: true });
 const temporary = `${paths.launcher}.${randomUUID()}`;
 await writeFile(temporary, launcherScript(paths.data), { mode: 0o755 });
 await rename(temporary, paths.launcher);
}

export async function pathAdvice(paths, env = process.env) {
 const entries = (env.PATH ?? '').split(':').filter(Boolean).map(entry => resolve(entry));
 for (const directory of entries) {
  if (directory === resolve(paths.bin)) return undefined;
  const candidate = join(directory, 'rer');
  try {
   await access(candidate, constants.X_OK);
   const found = await launcherOwner(await realpath(candidate));
   if (found.state === 'ours' && found.root === paths.data) return undefined;
   break; // This command shadows the canonical launcher, even if it is later on PATH.
  } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
 }
 if (basename(env.SHELL ?? '') === 'fish') return `Activate rer in this shell:\n  set -gx PATH ${shellQuote(paths.bin)} $PATH`;
 return `Activate rer in this shell:\n  export PATH=${shellQuote(paths.bin)}:"$PATH"`;
}

export async function install() {
 const paths = layout(), manifest = ownManifest(), digest = await packageDigest(ownRoot);
 const name = `${manifest.version}-${digest.slice(0, 8)}`, channel = process.env.RER_INSTALL_CHANNEL === 'script' ? 'script' : 'npx';
 const launcher = await launcherOwner(paths.launcher);
 if (launcher.state === 'foreign') {
  process.stderr.write(`rer cli install: ${paths.launcher} already exists and was not written by rer cli install (it may be the unrelated npm package "rer"). Nothing was changed. Remove or rename it, then run the install again.\n`);
  return 4;
 }
 const record = await installRecord(paths), current = await readLink(paths.current);
 const script = launcherScript(paths.data);
 let present = false;
 try { present = await packageDigest(join(paths.versions, name)) === digest; } catch (error) { if (error.code !== 'ENOENT') throw error; }
 if (present && current === join('versions', name) && launcher.text === script && record?.channel === channel) {
  const advice = await activation(paths, record);
  process.stdout.write(`rer ${manifest.version} is already current (${join(paths.versions, name)}). Nothing changed.\n${advice ? advice + '\n' : ''}`);
  return 0;
 }
 if (!present) { await rm(join(paths.versions, name), { recursive: true, force: true }); await copyVersion(paths, name); }
 const previousName = current?.startsWith('versions/') && current !== join('versions', name) ? current.slice('versions/'.length) : record?.previous;
 if (current !== join('versions', name)) await switchCurrent(paths, name);
 // A running front door keeps running from its own version: never prune it.
 const door = await runningDoor().catch(() => undefined);
 const doorVersion = door?.versionDir && resolve(door.versionDir, '..') === await realpath(paths.versions).catch(() => resolve(paths.versions)) ? basename(door.versionDir) : undefined;
 const keep = new Set([name, previousName, doorVersion].filter(Boolean));
 for (const entry of await readdir(paths.versions)) if (!keep.has(entry) && !entry.startsWith('.staging-')) await rm(join(paths.versions, entry), { recursive: true, force: true });
 await writeFile(paths.record, JSON.stringify({ channel, links: record?.links ?? [], previous: previousName && keep.has(previousName) ? previousName : null }, null, 2) + '\n', { mode: 0o644 });
 if (launcher.text !== script) await writeLauncher(paths);
 const advice = await activation(paths, await installRecord(paths));
 process.stdout.write(`Installed rer ${manifest.version} in ${join(paths.versions, name)}.\n${paths.launcher} runs it.${previousName ? ` The previous version (${previousName}) is kept.` : ''}\n${advice ? advice + '\n' : ''}`);
 return 0;
}

async function activation(paths, record) {
 const link = await exposeLauncher(paths);
 const links = [...new Set([...(record?.links ?? []), ...(link ? [link] : [])])];
 if (JSON.stringify(record?.links ?? []) !== JSON.stringify(links)) await writeFile(paths.record, JSON.stringify({ ...record, links }, null, 2) + '\n', { mode: 0o644 });
 return link ? undefined : await pathAdvice(paths);
}
