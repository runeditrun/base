// Experimental process instrumentation. Every operation delegates unchanged;
// the parent kills only its recorded updater PID at a real rollback boundary.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const { RER_ROLLBACK_PROBE: controlPath } = process.env;
function control() {
 if (!controlPath) return;
 try {
  const value = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  if (value.pid === process.pid) return value;
 } catch {}
}
function rolling() {
 const c = control();
 if (!c) return;
 try {
  const journal = JSON.parse(fs.readFileSync(join(c.checkout, '.rer/upgrade/journal.json'), 'utf8'));
  if (journal.stage === 'rolling_back' || c.acceptLegacy && ['switched', 'installed', 'started'].includes(journal.stage)) return { ...c, journal };
 } catch {}
}
function pause(boundary, c = rolling()) {
 if (!c || c.boundary !== boundary) return;
 fs.writeFileSync(c.reached, JSON.stringify({ pid: process.pid, boundary, stage: c.journal.stage }));
 // No substituted Git, data or runtime result: execution remains at this
 // actual boundary until the owning test signals this exact process.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
 throw Error('Rollback boundary probe was not interrupted by its parent');
}
const spawn = childProcess.spawn;
childProcess.spawn = function(program, args, options) {
 const c = rolling();
 const reset = program === 'git' && args.includes('reset') && args.includes('--hard');
 if (c && reset) pause('before-reset', c);
 const child = spawn.call(this, program, args, options);
 if (c && reset) child.once('exit', code => { if (code === 0) pause('after-reset', c); });
 const verb = program === process.execPath && args.some(arg => /(?:^|\/)rer\.mjs$/.test(arg));
 if (c && verb && args.includes('install')) child.once('exit', code => { if (code === 0) pause('after-install', c); });
 if (c && verb && args.includes('dev') && !args.includes('--stop')) child.once('exit', code => { if (code === 0) pause('after-restart', c); });
 return child;
};
const cp = promises.cp;
function lastComponent(c, destination, absent) {
 try {
  const metadata = JSON.parse(fs.readFileSync(join(c.checkout, '.rer/upgrade/backups', c.journal.backup, 'backup.json'), 'utf8'));
  const last = metadata.paths.at(-1);
  return resolve(destination) === join(c.checkout, last) && (metadata.components[last] === null) === absent;
 } catch { return false; }
}
promises.cp = async function(source, destination, options) {
 const value = await cp.call(this, source, destination, options);
 const c = rolling();
 if (c && resolve(source).startsWith(join(c.checkout, '.rer/upgrade/backups', c.journal.backup, 'state') + '/')) {
  if (resolve(destination) === join(c.checkout, '.wrangler/state')) pause('mid-restore', c);
  if (lastComponent(c, destination, false)) pause('after-restore', c);
 }
 return value;
};
const rm = promises.rm;
promises.rm = async function(destination, options) {
 const value = await rm.call(this, destination, options), c = rolling();
 if (c && lastComponent(c, destination, true)) pause('after-restore', c);
 return value;
};
const rename = promises.rename;
promises.rename = async function(source, destination) {
 const value = await rename.call(this, source, destination), c = rolling();
 if (c && resolve(destination) === join(c.checkout, '.rer/upgrade/journal.json')) pause('before-stop', c);
 return value;
};
syncBuiltinESMExports();
