import { resolve } from 'node:path';
import { Containers } from './isolation.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
export async function runBrowser(input, { env, image }) {
  const containers = new Containers(env);
  try {
    const id = await containers.create(image, [{ source: resolve(new URL('../../', import.meta.url).pathname), target: '/controller' }],
      { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', T016_BROWSER_CONTAINER: '1' });
    const result = await containers.require(['exec', '--interactive', id, 'node', '/controller/live-proofs/t016/browser-entry.mjs'],
      { input: JSON.stringify(input), timeout: 180000, limit: 128000 });
    const state = JSON.parse(result.output.toString());
    insist(state && typeof state === 'object', 'browser-result-invalid'); return state;
  } finally { await containers.close(); }
}
