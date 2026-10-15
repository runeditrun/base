import { missing } from './errors.mjs';
import { shared } from './shared.mjs';

// A version check owns its descendants just like a lifecycle command. Cleanup
// starts at leader exit, even when quiet descendants still hold the pipes.
// The package manager never sees the caller's credentials. A failed probe's
// error carries `reason`: what pnpm did instead of printing its version.
export async function probePnpm(root, store, signal, env = process.env, timeoutMs = 10000) {
 const { dependencyEnvironment } = await shared('dependency-environment.mjs');
 const timeout = AbortSignal.timeout(timeoutMs), probeSignal = AbortSignal.any([signal, timeout].filter(Boolean));
 let child, result, cleanup, version = '', errors = '';
 // Redact before bounding the text: a limit must not cut through a secret.
 const filter = store.redactionStream(text => { errors = (errors + text).slice(-4096); });
 try {
  child = store.spawn('Checking pinned pnpm', 'pnpm', ['--version'], { cwd: root, env: dependencyEnvironment(env), signal: probeSignal });
  child.stdout.on('data', chunk => { version = (version + chunk).slice(-1024); });
  child.stderr.on('data', chunk => filter.write(chunk));
  result = await new Promise(resolve => { child.once('error', error => resolve({ code: null, error })); child.once('exit', (code, exitSignal) => resolve({ code, exitSignal })); });
 } catch (error) { result = { code: null, error }; }
 if (child) try { await store.stop(child); } catch (error) { cleanup = store.redact(String(error.message)); }
 filter.end();
 const { code, exitSignal, error } = result;
 if (code === 0 && !probeSignal.aborted && !cleanup) return version.trim();
 const line = errors.split('\n').map(text => text.trim()).find(Boolean)?.slice(0, 200);
 const reason = timeout.aborted ? `pnpm --version gave no answer within ${timeoutMs / 1000} s`
  : error ? `pnpm could not start (${store.redact(error.code ?? error.message)})`
  : cleanup ? `pnpm --version exited ${code}; process cleanup failed: ${cleanup}`
  : code === null ? `pnpm --version was stopped by ${exitSignal}`
  : `pnpm --version exited ${code}${line ? `: ${line}` : ''}`;
 const diagnostic = `Command: pnpm --version\nExit code: ${code ?? 'none'}; signal: ${exitSignal ?? 'none'}\nStderr (redacted):\n${errors.trim() || '(no stderr)'}`;
 const message = `The pinned pnpm version probe failed (${reason}).\n${diagnostic}\nSelect the documented tool.`;
 throw Object.assign(missing(message), { reason, diagnostic });
}
