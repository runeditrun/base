import { missing } from './errors.mjs';
import { shared } from './shared.mjs';

// A version check owns its descendants just like a lifecycle command. Cleanup
// starts at leader exit, even when quiet descendants still hold the pipes.
// The package manager never sees the caller's credentials.
export async function probePnpm(root, store, signal, env = process.env) {
 const { dependencyEnvironment } = await shared('dependency-environment.mjs');
 const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)].filter(Boolean));
 const child = store.spawn('Checking pinned pnpm', 'pnpm', ['--version'], { cwd: root, env: dependencyEnvironment(env), signal: probeSignal });
 let version = '';
 child.stdout.on('data', chunk => { version = (version + chunk).slice(-1024); });
 const code = await new Promise(resolve => { child.once('error', () => resolve(null)); child.once('exit', code => resolve(code)); });
 await store.stop(child);
 if (probeSignal.aborted || code !== 0) throw missing('The pinned pnpm version probe failed. Select the documented tool.');
 return version.trim();
}
