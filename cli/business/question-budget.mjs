import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from './state.mjs';

// Spend limits on this computer. An owner may only lower them at connect.
export const defaultLimits = { questionsPerHour: 30, maxBudgetUsd: 0.05 };
const hour = 3_600_000;

export function questionLimits(state) {
 const questions = state?.limits?.questionsPerHour, budget = state?.limits?.maxBudgetUsd;
 return {
  questionsPerHour: Number.isSafeInteger(questions) && questions >= 1 && questions <= defaultLimits.questionsPerHour ? questions : defaultLimits.questionsPerHour,
  maxBudgetUsd: typeof budget === 'number' && budget > 0 && budget <= defaultLimits.maxBudgetUsd ? budget : defaultLimits.maxBudgetUsd,
 };
}

export class QuestionsPaused extends Error {
 constructor(limit) { super(`Business questions paused: ${limit} model questions this hour reached the local limit.`); }
}

const file = () => join(stateDirectory(), 'model-questions.json');
async function recent(now) {
 let started = [];
 try { started = JSON.parse(await readFile(file(), 'utf8')); }
 catch (error) { if (error.code !== 'ENOENT') throw error; }
 return Array.isArray(started) ? started.filter(time => Number.isFinite(time) && time > now - hour && time <= now) : [];
}

export async function questionsLeft(limit, now = Date.now()) { return Math.max(0, limit - (await recent(now)).length); }

// Record a model start before it happens; refuse once the hour is used up.
// Only the supervisor, under its lock, starts model questions.
export async function takeQuestion(limit, now = Date.now()) {
 const started = await recent(now);
 if (started.length >= limit) throw new QuestionsPaused(limit);
 const directory = stateDirectory(), temporary = join(directory, `${randomUUID()}.tmp`);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 try {
  await writeFile(temporary, JSON.stringify([...started, now]), { flag: 'wx', mode: 0o600 });
  await rename(temporary, file());
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
