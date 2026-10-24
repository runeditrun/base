import { savedOrigin } from './door-mode.mjs';
import { refuse } from './errors.mjs';
import { listenHost } from './parse.mjs';
import { shellQuote } from './node-runtime-cache.mjs';
import { defaultPort } from './port.mjs';

// Origin never selected the import target: an omitted target restores locally.
// Check before runtime selection, queue admission, recovery or archive access.
// savedOrigin reads settings without readSettings' directory preparation.
export async function importOriginRefusal(project, options) {
 const origin = new URL(options.origin), loopback = url => listenHost(url.hostname.replace(/^\[|\]$/g, ''));
 const saved = await savedOrigin(project);
 let local;
 try { if (saved) local = new URL(saved); } catch { /* Lifecycle reports malformed saved settings. */ }
 const port = local ? Number(local.port || 80) : defaultPort;
 if (origin.protocol === 'http:' && loopback(origin) && Number(origin.port || 80) === port) return;
 const here = `--origin ${origin.origin} is not this checkout's local app (${local && loopback(local) ? local.origin : `http://127.0.0.1:${port}`})`, restore = `rer import --input ${options.input === undefined ? 'FILE' : shellQuote(options.input)} --yes`;
 // Only a seed that can restore into its hosted app is sent to --target remote.
 const api = project.adapter?.portability;
 if (api?.remote === true && typeof api.import === 'function') return refuse(`${here}. To restore into the hosted app at that address, add --target remote; to restore here, run: ${restore}`);
 return refuse(`${here}, and this seed restores an installation archive only into its local app. To restore here, run: ${restore}. To bring records into the app at ${origin.origin}, use its owner import screen: ${origin.origin}/app/import`);
}
