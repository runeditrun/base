import { assert } from './validation.mjs';

/** Match native adapters: only an explicit free_tier boolean identifies the plan. */
export async function limitsForAccount(api, limits, signal) {
  if (limits?.cpu_ms === undefined) return limits;
  let settings;
  try { settings = await api.request('/workers/settings', {signal}); }
  catch (cause) {
    signal?.throwIfAborted();
    throw new Error('workers-plan-lookup-failed', {cause});
  }
  assert(typeof settings?.free_tier === 'boolean', 'workers-plan-unknown');
  if (!settings.free_tier) return limits;
  const {cpu_ms, ...remaining} = limits;
  return Object.keys(remaining).length ? remaining : undefined;
}

const messages = new Map([
  ['workers-plan-lookup-failed', 'Cloudflare Workers settings could not be read. Check the account and API token permissions, then retry deployment.'],
  ['workers-plan-unknown', 'Cloudflare Workers settings did not identify the account plan. Confirm the plan in Cloudflare, then retry deployment.'],
  ['worker-cpu-limit-readback-mismatch', 'Cloudflare did not report the configured CPU limit for the uploaded Worker. Check the Worker settings in Cloudflare.'],
]);
export const workerLimitsMessage = code => messages.get(code);
