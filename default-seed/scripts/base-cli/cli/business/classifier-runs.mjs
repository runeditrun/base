import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { stateDirectory } from './state.mjs';
import { returnRefreshedCredentials } from './codex-home.mjs';

// Each model question keeps a record under ~/.rer/business/classifier/: its
// scratch folder, Codex's private home and every process group it started.
// A killed supervisor leaves the record behind; the next start (under the
// supervisor lock) and disconnect stop any survivor and remove what remains.
export const classifierDirectory = () => join(stateDirectory(), 'classifier');
const scratchName = /^rer-business-classifier-[A-Za-z0-9]{6}$/;

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
 record.temporary = await mkdtemp(join(tmpdir(), 'rer-business-classifier-'));
 save();
 return {
  temporary: record.temporary, home: join(directory, 'home'),
  track: group => { record.groups.push(group); save(); },
  copiedCodexAuth: copied => { record.codexAuth = copied; save(); },
  finish: async () => {
   await rm(record.temporary, { recursive: true, force: true });
   await rm(directory, { recursive: true, force: true });
  },
 };
}

function processTable() {
 return new Promise((resolveTable, reject) => execFile('/bin/ps', ['-A', '-ww', '-o', 'pgid=,stat=,args='], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
  if (error) reject(Error('Business could not list processes to stop a killed classifier.'));
  else resolveTable(stdout.split('\n').map(line => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, group, state, args]) => ({ group: Number(group), zombie: state.startsWith('Z'), args })));
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
  groups: record.groups.filter(group => Number.isSafeInteger(group) && group > 1 && group !== process.pid),
  codexAuth: typeof record.codexAuth === 'string' && /^[0-9a-f]{64}$/.test(record.codexAuth) ? record.codexAuth : null,
 };
}

// A killed group is stopped once only exited members, awaiting the system's
// reaping, remain (signalling such a group can fail with EPERM on macOS).
async function stopped(group) {
 for (let attempt = 0; attempt < 100; attempt++) {
  if (!(await processTable()).some(entry => entry.group === group && !entry.zombie)) return;
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
 }
 throw Error('Business could not stop a killed classifier. Retry shortly.');
}

// Stop a recorded group only while one of its members still names this run's
// executable or scratch folder, so a reused process id is never touched.
export async function sweepRuns() {
 let names;
 try { names = await readdir(classifierDirectory()); }
 catch (error) { if (error.code === 'ENOENT') return; throw error; }
 const runs = await Promise.all(names.map(async name => {
  const directory = join(classifierDirectory(), name);
  return { directory, record: await readRun(directory) };
 }));
 if (runs.some(({ record }) => record?.groups.length)) {
  const table = await processTable();
  for (const { record } of runs) for (const group of record?.groups ?? []) {
   const members = table.filter(entry => entry.group === group);
   if (!members.some(entry => !entry.zombie && (entry.args.includes(record.executable) || record.temporary && entry.args.includes(record.temporary)))) continue;
   try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
   await stopped(group);
  }
 }
 for (const { directory, record } of runs) {
  // A survivor may have refreshed the copied Codex login before it stopped.
  if (record?.codexAuth) await returnRefreshedCredentials(record.codexAuth, join(directory, 'home/.codex'));
  if (record?.temporary) await rm(record.temporary, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
 }
}
