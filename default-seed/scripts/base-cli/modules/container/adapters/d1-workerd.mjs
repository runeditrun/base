import { D1_PLUGIN } from 'miniflare';
import { installD1Preflight } from './d1-workerd-setup.mjs';
export * from 'miniflare';
export { installD1Preflight } from './d1-workerd-setup.mjs';
installD1Preflight(D1_PLUGIN);
