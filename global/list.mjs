// rer list [DIR] [--json]: the immediate subfolders of DIR that hold an
// OPERATIONS.json, newest change first, with what rer dev can do for each.
import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { descriptorProfile, dispatcher, pinnedPackage } from './checkout.mjs';
import { liveServers } from './registry.mjs';
import { describeCheckout, setupNeeded } from './launch/facts.mjs';
import { launchPath, setupState } from './launch/state.mjs';

const run = promisify(execFile);
const reasons = {
 independent: 'independent project: rer runs its declared commands; zero-setup rer dev applies to first-party seeds only',
 unreadable: 'OPERATIONS.json cannot be read',
};

async function changed(path) {
 try { const { stdout } = await run('git', ['-C', path, 'log', '-1', '--format=%ct'], { timeout: 10000 }); if (/^\d+$/.test(stdout.trim())) return Number(stdout.trim()) * 1000; } catch {}
 return (await stat(path)).mtimeMs;
}

async function entry(path, running) {
 const facts = descriptorProfile(join(path, 'OPERATIONS.json'));
 const profile = ['first-party', 'independent'].includes(facts.profile) ? facts.profile : 'unsupported';
 const result = { path, name: path.split('/').pop(), profile, launchable: profile === 'first-party' };
 if (!result.launchable) result.reason = reasons[facts.profile] ?? `OPERATIONS.json is version ${facts.version ?? '(none)'}, which rer does not run`;
 result.prepared = null;
 if (profile === 'first-party') {
  // Set up: saved settings, and no setup a launch started left unfinished. A
  // checkout whose pinned rer package is not installed yet has never been
  // launched: rer dev installs it first.
  if (pinnedPackage(path)?.ready === false) result.prepared = false;
  else try { result.prepared = !await setupNeeded(path, await describeCheckout(path, dispatcher(path).entry, process.env), await setupState.read(launchPath(path))); }
  catch (failure) { result.launchable = false; result.reason = `rer describe fails here: ${failure.message.split('\n')[0]}`; }
 }
 result.url = running.get(path) ?? null;
 result.changedAt = new Date(await changed(path)).toISOString();
 return result;
}

export async function listCommand(args) {
 if (args.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write('Usage: rer list [DIR] [--json]\nThe checkouts in DIR (default: here), newest first, with whether rer dev can launch them,\nwhether they are set up, and their running URL. --json for data.\n'); return 0; }
 const json = args.includes('--json'), positional = args.filter(arg => arg !== '--json');
 if (positional.length > 1 || positional.some(arg => arg.startsWith('-'))) { process.stderr.write('Usage: rer list [DIR] [--json]\n'); return 2; }
 let directory;
 try { directory = await realpath(resolve(positional[0] ?? '.')); } catch { process.stderr.write(`rer list: ${resolve(positional[0] ?? '.')} is not a folder.\n`); return 3; }
 const running = new Map((await liveServers()).map(record => [record.checkout, record.url]));
 const folders = [];
 for (const item of await readdir(directory, { withFileTypes: true })) {
  const path = join(directory, item.name);
  try { if ((await stat(path)).isDirectory() && (await stat(join(path, 'OPERATIONS.json'))).isFile()) folders.push(await realpath(path)); } catch {}
 }
 const checkouts = [];
 for (let i = 0; i < folders.length; i += 4) checkouts.push(...await Promise.all(folders.slice(i, i + 4).map(path => entry(path, running))));
 checkouts.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.name.localeCompare(b.name));
 if (json) { process.stdout.write(JSON.stringify({ directory, checkouts }) + '\n'); return 0; }
 if (!checkouts.length) { process.stdout.write(`No checkouts with an OPERATIONS.json in ${directory}.\n`); return 0; }
 const width = Math.max(4, ...checkouts.map(item => item.name.length));
 const rows = checkouts.map(item => `${item.name.padEnd(width)}  ${item.profile.padEnd(11)}  ${(item.launchable ? 'yes' : 'no').padEnd(6)}  ${(item.prepared === null ? '-' : item.prepared ? 'yes' : 'no').padEnd(8)}  ${item.url ?? (item.launchable ? '-' : item.reason)}`);
 process.stdout.write([`${'NAME'.padEnd(width)}  ${'PROFILE'.padEnd(11)}  LAUNCH  PREPARED  URL`, ...rows, '', 'Launch one with: rer dev --cwd FOLDER'].join('\n') + '\n');
 return 0;
}
