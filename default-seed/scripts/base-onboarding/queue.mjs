import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
const portable = basename(dirname(fileURLToPath(import.meta.url))) === 'base-onboarding';
const queueURL = new URL(portable ? '../base-cli/modules/job-queue/' : '../modules/job-queue/', import.meta.url);
// Keep the operational default while allowing callers to bound admission sooner.
export const maxWaitSeconds = Number(process.env.RER_JOBS_MAX_WAIT_SECONDS ?? 1200);
export const heavyVerbs = new Set(['install', 'setup', 'build', 'verify', 'dev', 'preview', 'deploy', 'release', 'export', 'import', 'installer']);
export const verificationBoundary = verb => verb === 'release' || verb === 'verify' || verb?.startsWith('verify:');
// The seed's display name (seed.json `name`, else its folder name) for terminal lines,
// never its package or project id; the hash tells two checkouts of one seed apart.
export async function queueLabel(root, verb, phase) {
 root = await realpath(root);
 let name = basename(root);
 try {
  const value = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8')).name;
  if (typeof value === 'string' && value.trim() && !/[\p{Cc}]/u.test(value) && value.length <= 80) name = value.trim();
 } catch {}
 return `${name} ${verb}:${phase} [${createHash('sha256').update(root).digest('hex').slice(0, 12)}]`;
}

function shellQuote(value) {
 if (process.platform === 'win32') return `"${String(value).replaceAll('"', '""')}"`;
 return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function waitingText(wait, waitingMessage) {
 return `${waitingMessage(wait)}\nRun from the project root. Inspect the queue with: ${wait.statusCommandText}`;
}

export async function queuedCommand(command, args, options) {
 const { createQueue } = await import(new URL('index.mjs', queueURL));
 const { liveMembership } = await import(new URL('membership.mjs', queueURL));
 const { waitingMessage } = await import(new URL('waiting.mjs', queueURL));
 const statusCommand = [process.execPath, fileURLToPath(new URL('cli.mjs', queueURL)), 'status', '--json'];
 // An inherited credential-shaped PWD can redact an absolute project prefix.
 // Keep the human recipe relative while retaining the executable argv for tools.
 const statusCommandText = [basename(process.execPath), relative(options.cwd ?? process.cwd(), statusCommand[1]), ...statusCommand.slice(2)].map(shellQuote).join(' ');
 // Read the original caller's decision before an install synthesizes CI=true.
 if (options.originalCI === true || await liveMembership()) {
  if (verificationBoundary(options.verb)) {
   const { waitForLoad } = await import(new URL('load-admission.mjs', queueURL));
   return waitForLoad(options);
  }
  return null;
 }
 const queue = await createQueue(options.queueOptions);
 try {
  const result = await queue.run([command, ...args], { ...options, kind: 'heavy', maxWait: options.maxWait ?? maxWaitSeconds,
   onWaiting: (reason, detail) => {
    const wait = { ...(detail ?? { reason }), statusCommand, statusCommandText };
    if (typeof options.onWaiting === 'function') return options.onWaiting(wait);
    return options.report?.(waitingText(wait, waitingMessage));
   },
   onStarted: () => options.report(`Heavy job admitted: ${options.label}`) });
  if (result.supervisorEnded) options.report?.(result.error);
  return result;
 } finally { await queue.close(); }
}

export async function commandPolicy(){const {callerPolicy}=await import(new URL('policy.mjs',queueURL));return callerPolicy();}
