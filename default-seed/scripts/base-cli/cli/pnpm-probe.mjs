import { missing } from './errors.mjs';
import { shared } from './shared.mjs';

// A version check owns its descendants just like a lifecycle command. Cleanup
// starts at leader exit, even when quiet descendants still hold the pipes.
// The package manager never sees the caller's credentials. A failed probe's
// error carries `reason`: what pnpm did instead of printing its version.
export async function probePnpm(root, store, signal, env = process.env, timeoutMs = 10000) {
 const { dependencyEnvironment } = await shared('dependency-environment.mjs');
 const timeout = AbortSignal.timeout(timeoutMs), probeSignal = AbortSignal.any([signal, timeout].filter(Boolean));
 const child = store.spawn('Checking pinned pnpm', 'pnpm', ['--version'], { cwd: root, env: dependencyEnvironment(env), signal: probeSignal });
 let version = '', errors = '';
 child.stdout.on('data', chunk => { version = (version + chunk).slice(-1024); });
 child.stderr.on('data', chunk => { errors = (errors + chunk).slice(0, 4096); });
 const { code, exitSignal, error } = await new Promise(resolve => { child.once('error', error => resolve({ code: null, error })); child.once('exit', (code, exitSignal) => resolve({ code, exitSignal })); });
 await store.stop(child);
 if (code === 0 && !probeSignal.aborted) return version.trim();
 const line = (store.redact?.(errors) ?? errors).split('\n').map(text => text.trim()).find(Boolean)?.slice(0, 200);
 const reason = timeout.aborted ? `pnpm --version gave no answer within ${timeoutMs / 1000} s`
  : error ? `pnpm could not start (${error.code ?? error.message})`
  : code === null ? `pnpm --version was stopped by ${exitSignal}`
  : `pnpm --version exited ${code}${line ? `: ${line}` : ''}`;
 throw Object.assign(missing(`The pinned pnpm version probe failed (${reason}). Select the documented tool.`), { reason });
}
