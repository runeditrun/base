// A checkout that pins the @runeditrun/rer package runs its own rer once
// node_modules holds the pinned version; until then none of it can run (its
// adapter imports the package). So its first dependency install is this
// launcher's: the frozen pnpm install that `rer install` runs. Like every
// dependency install, it runs with an allowlisted environment. Verbs started
// at once share one install: each takes the checkout's install claim and
// installs only if the pin is still missing once it holds it.
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dependencyEnvironment } from '../../onboarding/dependency-environment.mjs';
import { pinnedPackage } from '../checkout.mjs';
import { packageName } from '../package-info.mjs';
import { ensureProjectPnpm } from '../../cli/project-pnpm.mjs';
import { RerError } from '../../cli/errors.mjs';
import { LaunchFailure } from './failure.mjs';
import { claimPinInstall, settledPinInstall } from './state.mjs';

const waiting = (root, output) => pid => output(`Another rer (PID ${pid}) is installing ${root}'s pinned ${packageName}; waiting for it.\n`);

export async function installPinned(root, { env = process.env, output = text => process.stderr.write(text), children, signal } = {}) {
 signal?.throwIfAborted();
 const release = await claimPinInstall(await realpath(root), { env, signal, onWait: waiting(root, output) });
 try {
  const pinned = pinnedPackage(root);
  if (pinned?.ready) return;
  if (pinned?.installed) output(`${root} pins ${packageName} ${pinned.declared}, but node_modules holds ${pinned.installed}; installing the pinned version first.\n`);
  await install(root, { env, output, children, signal });
 } finally { await release(); }
}

// A verb on a checkout whose pin looks installed still waits for an install
// another verb is running there: node_modules is not complete until it ends.
export async function settledPin(root, { env = process.env, output = text => process.stderr.write(text), signal } = {}) {
 await settledPinInstall(await realpath(root), { env, signal, onWait: waiting(root, output) });
}

async function install(root, { env, output, children, signal }) {
 try { await ensureProjectPnpm(root, { env, signal, report: text => output(text + '\n') }); }
 catch (error) { if (error instanceof RerError) throw new LaunchFailure(error.exitCode, error.message); throw error; }
 const child = spawn('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env: { ...dependencyEnvironment(env), CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
 children?.add(child);
 if (signal?.aborted) child.kill('SIGTERM');
 let tail = '';
 for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { tail = (tail + data).slice(-4096); output(String(data)); });
 const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exit, name) => resolve(exit ?? (name ? 128 : 1))); });
 children?.delete(child);
 if (code !== 0) throw new LaunchFailure(code, `pnpm install --frozen-lockfile failed in ${root} (exit ${code}):\n${tail.trim().split('\n').slice(-8).join('\n')}`);
 const pinned = pinnedPackage(root);
 if (!pinned?.ready) throw new LaunchFailure(3, `${root} pins ${packageName} ${pinned?.declared}, but after pnpm install node_modules holds ${pinned?.installed ?? 'no copy of it'}. Correct the pin or the lockfile (pnpm install), then run rer again.`);
}
