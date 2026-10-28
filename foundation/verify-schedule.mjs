import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const scheduleTransformation = 'Seed-name hash rendered as one static Monday and Thursday cron between 02:00 and 07:59 UTC';
export function renderVerifySchedule(text, seed) {
 if (typeof seed !== 'string' || !seed.trim()) throw Error('Schedule rendering requires the seed name');
 const minute = 120 + createHash('sha256').update(seed).digest().readUInt32BE(0) % 360;
 const cron = `${minute % 60} ${Math.floor(minute / 60)} * * 1,4`;
 const schedules = [...text.matchAll(/^(\s*- cron:)\s*['"][^'"\r\n]+['"]\s*$/gm)];
 if (schedules.length !== 1) throw Error('Expected one static nightly schedule');
 return text.replace(schedules[0][0], `${schedules[0][1]} '${cron}'`);
}

// Regenerate maintained helper mirrors from their authoritative export source.
if (process.argv[1] === import.meta.filename) {
 if (process.argv.length !== 3 || process.argv[2] !== '--mirrors') throw Error('Usage: node foundation/verify-schedule.mjs --mirrors');
 const base = resolve(import.meta.dirname, '..');
 for (const target of ['default-seed', 'foundation/template']) {
  await mkdir(resolve(base, target, 'scripts'), { recursive: true });
  for (const name of ['verify-ci.mjs', 'verify-evidence.mjs', 'verify-plan.mjs', 'verify-light.mjs']) {
   await cp(resolve(base, 'export', name), resolve(base, target, 'scripts', name));
  }
 }
 // Parsing and rendering the authoritative template also refuses drift early.
 await writeFile(resolve(base, 'export/verify-nightly.yml'), renderVerifySchedule(await readFile(resolve(base, 'export/verify-nightly.yml'), 'utf8'), 'base'));
}
