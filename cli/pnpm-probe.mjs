import { missing } from './errors.mjs';

// A version check owns its descendants just like a lifecycle command. Cleanup
// starts at leader exit, even when quiet descendants still hold the pipes.
export async function probePnpm(root, store, signal, env = process.env) {
 const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)].filter(Boolean));
 const child = store.spawn('Checking pinned pnpm', 'pnpm', ['--version'], { cwd: root, env, signal: probeSignal });
 let version = '';
 child.stdout.on('data', chunk => { version = (version + chunk).slice(-1024); });
 const code = await new Promise(resolve => { child.once('error', () => resolve(null)); child.once('exit', code => resolve(code)); });
 await store.stop(child);
 if (probeSignal.aborted || code !== 0) throw missing('The pinned pnpm version probe failed. Select the documented tool.');
 return version.trim();
}
