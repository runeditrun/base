import { savedOrigin } from './door-mode.mjs';
import { refuse } from './errors.mjs';
import { listenHost } from './parse.mjs';
import { defaultPort } from './port.mjs';

// Origin never selected the import target: an omitted target restores locally.
// Check before runtime selection, queue admission, recovery or archive access.
// savedOrigin reads settings without readSettings' directory preparation.
export async function importOriginRefusal(project, options) {
 const origin = new URL(options.origin);
 if (origin.protocol === 'http:' && listenHost(origin.hostname.replace(/^\[|\]$/g, ''))) {
  const saved = await savedOrigin(project);
  let local;
  try { if (saved) local = new URL(saved); } catch { /* Lifecycle reports malformed saved settings. */ }
  const port = local ? Number(local.port || 80) : defaultPort;
  if (Number(origin.port || 80) === port) return;
 }
 return refuse(`--origin ${origin.origin} is not this computer's app; to import into the hosted app use --target remote, or drop --origin to restore the local app.`);
}
