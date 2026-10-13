// A checkout that pins the @runeditrun/rer package runs its own rer once
// node_modules holds the pinned version; until then none of it can run (its
// adapter imports the package). So its first dependency install is this
// launcher's: the frozen pnpm install that `rer install` runs.
import { spawn } from 'node:child_process';
import { pinnedPackage } from '../checkout.mjs';
import { packageName } from '../package-info.mjs';
import { ensureProjectPnpm } from '../../cli/project-pnpm.mjs';
import { RerError } from '../../cli/errors.mjs';
import { LaunchFailure } from './failure.mjs';

export async function installPinned(root, { env = process.env, output = text => process.stderr.write(text), children, signal } = {}) {
 signal?.throwIfAborted();
 try { await ensureProjectPnpm(root, { env, signal, report: text => output(text + '\n') }); }
 catch (error) { if (error instanceof RerError) throw new LaunchFailure(error.exitCode, error.message); throw error; }
 const child = spawn('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env: { ...env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
