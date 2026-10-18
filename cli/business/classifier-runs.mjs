import { execFile, execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { stateDirectory } from './state.mjs';
import { returnRefreshedCredentials } from './codex-home.mjs';

// Each model question keeps a record under ~/.rer/business/classifier/: its
// scratch folder, Codex's private home and every process group it started,
// with its leader's start time. A killed supervisor leaves the record behind;
// the next start (under the supervisor lock) and disconnect stop any survivor
// and remove what remains. Everything lives under that private folder, never
// in a shared temporary folder another user could recreate.
export const classifierDirectory = () => join(stateDirectory(), 'classifier');
const scratchName = /^rer-business-classifier-[A-Za-z0-9]{6}$/;

// A recorded folder is removed only while it is a real folder (not a link)
// that this user owns and nobody else can enter.
async function privateFolder(path) {
 try {
  const info = await lstat(path);
  return info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700;
 } catch { return false; }
}

// ps prints the start time in the C locale and UTC, so a record written by the
// supervisor matches what disconnect reads in another environment. Only the
// character type is kept, so non-ASCII arguments still print as text.
function psEnvironment() {
 const characters = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG;
 return { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_TIME: 'C', ...(characters ? { LC_CTYPE: characters } : {}) };
}
const startTime = text => text.trim().split(/\s+/).join(' ');

// Read synchronously as the child spawns, before any output is read, so the
// record never names a group without its leader's start time.
function leaderStart(pid) {
 try { return startTime(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: psEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] }).toString()) || null; }
 catch { return null; /* Already exited: its group has nothing left to stop. */ }
}

export async function startRun(executable) {
 await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
 await mkdir(classifierDirectory(), { recursive: true, mode: 0o700 });
 const directory = await mkdtemp(join(classifierDirectory(), 'run-'));
 const record = { executable, temporary: null, groups: [], codexAuth: null };
 // Written synchronously and atomically, so a kill never leaves a group out.
 const save = () => {
  const file = join(directory, 'run.json'), partial = `${file}.tmp`;
  writeFileSync(partial, JSON.stringify(record), { mode: 0o600 });
  renameSync(partial, file);
 };
 save();
 record.temporary = await mkdtemp(join(directory, 'rer-business-classifier-'));
 save();
 return {
  temporary: record.temporary, home: join(directory, 'home'),
  track: group => { record.groups.push({ group, start: leaderStart(group) }); save(); },
  copiedCodexAuth: copied => { record.codexAuth = copied; save(); },
  finish: async () => { await rm(directory, { recursive: true, force: true }); },
 };
}

// This user's processes only: group, own id, state, start time and arguments.
function processTable() {
 return new Promise((resolveTable, reject) => execFile('/bin/ps', ['-A', '-ww', '-o', 'pid=,pgid=,uid=,stat=,lstart=,args='], { env: psEnvironment(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
  if (error) { reject(Error('Business could not list processes to stop a killed classifier.')); return; }
  const uid = process.getuid();
  resolveTable(stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line)).filter(Boolean)
   .map(([, pid, group, owner, state, start, args]) => ({ pid: Number(pid), group: Number(group), uid: Number(owner), zombie: state.startsWith('Z'), start: startTime(start), args }))
   .filter(entry => entry.uid === uid && !entry.zombie));
 }));
}

async function readRun(directory) {
 let record;
 try { record = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')); }
 catch { return null; /* Nothing was started before the record existed. */ }
 if (!record || typeof record !== 'object' || typeof record.executable !== 'string' || !isAbsolute(record.executable) || !Array.isArray(record.groups)) return null;
 return {
  executable: record.executable,
  temporary: typeof record.temporary === 'string' && isAbsolute(record.temporary) && scratchName.test(basename(record.temporary)) ? record.temporary : null,
  groups: record.groups.filter(entry => entry && Number.isSafeInteger(entry.group) && entry.group > 1 && entry.group !== process.pid && (entry.start === null || typeof entry.start === 'string')),
  codexAuth: typeof record.codexAuth === 'string' && /^[0-9a-f]{64}$/.test(record.codexAuth) ? record.codexAuth : null,
 };
}

// A recorded group is still this run's while its leader runs with the start
// time recorded at spawn and names the run's executable or scratch folder. A
// group whose leader has exited can hold no reused id, but a member must then
// name the run's own scratch folder, which no unrelated process does.
function ours(record, { group, start }, table) {
 const members = table.filter(entry => entry.group === group);
 const leader = members.find(entry => entry.pid === group);
 if (leader) return start !== null && leader.start === start && (leader.args.includes(record.executable) || Boolean(record.temporary) && leader.args.includes(record.temporary));
 return Boolean(record.temporary) && members.some(entry => entry.args.includes(record.temporary));
}

// A killed group is stopped once none of this user's members is left running
// (exited members awaiting the system's reaping do not count).
async function stopped(group) {
 for (let attempt = 0; attempt < 100; attempt++) {
  if (!(await processTable()).some(entry => entry.group === group)) return;
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
 }
 throw Error('Business could not stop a killed classifier. Retry shortly.');
}

// Removal never throws: a folder that cannot be removed is reported and left,
// and its record is dropped so it never blocks a start or disconnect.
async function remove(path, what) {
 try { await rm(path, { recursive: true, force: true }); return true; }
 catch (error) { process.stderr.write(`Business could not remove ${what} ${path} (${error.code ?? 'error'}); remove it by hand.\n`); return false; }
}

export async function sweepRuns() {
 let names;
 try { names = await readdir(classifierDirectory()); }
 catch (error) { if (error.code === 'ENOENT') return; throw error; }
 const runs = [];
 for (const name of names) {
  const directory = join(classifierDirectory(), name);
  // Only a private folder this user owns is a record; anything else is left untouched.
  if (await privateFolder(directory)) runs.push({ directory, record: await readRun(directory) });
 }
 if (runs.some(({ record }) => record?.groups.length)) {
  const table = await processTable();
  for (const { record } of runs) for (const entry of record?.groups ?? []) {
   if (!ours(record, entry, table)) continue;
   // EPERM: the group now belongs to someone else, so it is not this run's.
   try { process.kill(-entry.group, 'SIGKILL'); } catch (error) { if (error.code === 'ESRCH' || error.code === 'EPERM') continue; throw error; }
   await stopped(entry.group);
  }
 }
 for (const { directory, record } of runs) {
  // A survivor may have refreshed the copied Codex login before it stopped.
  if (record?.codexAuth) await returnRefreshedCredentials(record.codexAuth, join(directory, 'home/.codex'));
  if (record?.temporary && await privateFolder(record.temporary)) await remove(record.temporary, 'the classifier scratch folder');
  if (!(await remove(directory, 'the classifier record'))) await remove(join(directory, 'run.json'), 'the classifier record');
 }
}
