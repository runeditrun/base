import Module from 'node:module';
import { installD1Preflight } from './d1-workerd-setup.mjs';

// Test journeys launch Wrangler in child processes, often before dependencies
// exist. Hook its eventual CommonJS load instead of resolving a driver early.
// This also instruments the exact Miniflare instance chosen by Wrangler.
const installed = Symbol.for('rer.d1.child-preflight');
if (!Module[installed]) {
  const load = Module._load;
  Module._load = function (...args) {
    const value = load.apply(this, args);
    if (value && Object.hasOwn(value, 'D1_PLUGIN') && typeof value.Miniflare === 'function') installD1Preflight(value.D1_PLUGIN);
    return value;
  };
  Module[installed] = true;
}
const option = `--import=${import.meta.url}`;
const options = process.env.NODE_OPTIONS ?? '';
if (!options.includes(option)) process.env.NODE_OPTIONS = [options, option].filter(Boolean).join(' ');
