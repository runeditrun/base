import { assert } from './validation.mjs';

export function validateWorkerLimits(limits) {
  if (limits === undefined) return;
  assert(Number.isInteger(limits?.cpu_ms) && limits.cpu_ms >= 1 && limits.cpu_ms <= 300_000, 'invalid-worker-cpu-limit');
}

/** Match native adapters: only an explicit free_tier boolean identifies the plan. */
export async function limitsForAccount(api, limits, signal) {
  if (limits === undefined) return undefined;
  let settings;
  try { settings = await api.request('/workers/settings'); }
  catch (cause) {
    signal?.throwIfAborted();
    throw new Error('workers-plan-lookup-failed', {cause});
  }
  assert(typeof settings?.free_tier === 'boolean', 'workers-plan-unknown');
  return settings.free_tier ? undefined : {cpu_ms:limits.cpu_ms};
}

const messages = new Map([
  ['invalid-worker-cpu-limit', 'Wrangler limits.cpu_ms must be an integer from 1 to 300000. Correct the Worker config and rebuild.'],
  ['workers-plan-lookup-failed', 'Cloudflare Workers settings could not be read. Check the account and API token permissions, then retry deployment.'],
  ['workers-plan-unknown', 'Cloudflare Workers settings did not identify the account plan. Confirm the plan in Cloudflare, then retry deployment.'],
  ['worker-cpu-limit-readback-mismatch', 'Cloudflare did not report the configured CPU limit for the uploaded Worker. Check the Worker settings in Cloudflare.'],
]);
export const workerLimitsMessage = code => messages.get(code);
