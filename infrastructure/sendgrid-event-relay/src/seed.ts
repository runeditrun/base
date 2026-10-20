import { requirePublicDns, seedTarget } from './public-target.ts';

export interface SeedRegistration { seed: string; installationId: string; url: string; expiresAt: number }
export interface SeedRegistry { version: 1; targets: SeedRegistration[] }
export function seedRegistry(value?: string): SeedRegistry {
  if (!value) return { version: 1, targets: [] };
  if (value.length > 16_384) throw new Error('Invalid seed registry');
  let registry: SeedRegistry;
  try { registry = JSON.parse(value); } catch { throw new Error('Invalid seed registry JSON'); }
  if (registry?.version !== 1 || !Array.isArray(registry.targets) || registry.targets.length > 8) throw new Error('Invalid seed registry');
  const scopes = new Set<string>();
  for (const entry of registry.targets) {
    if (!entry || typeof entry.seed !== 'string' || typeof entry.installationId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.seed) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.installationId) || typeof entry.url !== 'string' ||
        !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt > Date.now() + 7 * 86_400_000) throw new Error('Invalid seed registration');
    seedTarget(entry.url);
    const scope = JSON.stringify([entry.seed, entry.installationId]);
    if (scopes.has(scope)) throw new Error('Duplicate seed scope');
    scopes.add(scope);
  }
  return registry;
}

type Event = Record<string, unknown>;
export async function deliverSeed(events: Event[], rawBody: Uint8Array<ArrayBuffer>, headers: Headers, value?: string): Promise<void> {
  const counts = { unknown: 0, expired: 0, mixedBatches: 0, configurationFailures: 0, targetFailures: 0, delivered: 0 };
  // Untagged legacy traffic never needs seed configuration or DNS.
  if (!events.some(event => Object.hasOwn(event, 'rer_seed') || Object.hasOwn(event, 'rer_test_installation'))) return;
  try {
    const registry = seedRegistry(value);
    let target: SeedRegistration | undefined;
    for (const event of events) {
      const entry = registry.targets.find(candidate => candidate.seed === event.rer_seed && candidate.installationId === event.rer_test_installation);
      if (!entry) counts.unknown++;
      else if (entry.expiresAt <= Date.now()) counts.expired++;
      else if (!target) target = entry;
    }
    // The provider signature covers the WHOLE array, never a filtered subset.
    const first = events[0];
    const mixed = events.some(event => event.rer_seed !== first.rer_seed || event.rer_test_installation !== first.rer_test_installation || event.rer_product !== first.rer_product);
    if (mixed) counts.mixedBatches++;
    if (!mixed && !counts.unknown && !counts.expired && target) {
      try { await requirePublicDns(seedTarget(target.url).hostname); }
      catch { counts.configurationFailures++; return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (target.expiresAt <= Date.now()) { counts.expired += events.length; return; }
        try {
          const response = await fetch(target.url, { method: 'POST', body: rawBody, redirect: 'manual', signal: AbortSignal.timeout(3_000),
            headers: { 'content-type': 'application/json', 'user-agent': 'RunEditRun-Mail-Relay/1',
              'x-twilio-email-event-webhook-signature': headers.get('x-twilio-email-event-webhook-signature')!,
              'x-twilio-email-event-webhook-timestamp': headers.get('x-twilio-email-event-webhook-timestamp')! } });
          await response.body?.cancel();
          if (response.ok) { counts.delivered++; return; }
          // Redirects and permanent client errors are never retried/followed.
          if (response.status < 500 && response.status !== 429) break;
        } catch { /* bounded network-edge retry only */ }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
      }
      counts.targetFailures++;
    }
  } catch { counts.configurationFailures++; }
  finally { console.info('Mail seed relay counts', counts); }
}
