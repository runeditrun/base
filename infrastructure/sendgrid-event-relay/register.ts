/** Authenticated owner registration preflight; stdout is the validated registry.
 * Pipe directly to Wrangler secret put. Never accepts event-provided URLs.
 */
import { readFile } from 'node:fs/promises';
import { seedRegistry } from './src/seed.ts';
import { requirePublicDns, seedTarget } from './src/public-target.ts';

async function main() {
  const path = process.argv[2];
  if (!path || !process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID !== 'b20c0ca9cab0c2b70e13d7cf724b89bd') {
    throw new Error('Registration requires a registry file and authenticated RunEditRun account');
  }
  const registry = seedRegistry(await readFile(path, 'utf8'));
  for (const target of registry.targets) {
    const hostname = seedTarget(target.url).hostname;
    if (target.expiresAt <= Date.now()) throw new Error('Registration is expired');
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(hostname)}`, {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Cannot establish authoritative Worker custom domains'); }
    const result = await response.json() as { success: boolean; result: { hostname: string; service: string; environment: string; enabled: boolean; zone_name: string }[] };
    if (!result.success || !Array.isArray(result.result)) throw new Error('Cannot establish authoritative Worker custom domains');
    if (!result.result.some(domain => domain.hostname === hostname && domain.service !== 'rer-sendgrid-event-relay' &&
        domain.environment === 'production' && domain.enabled && domain.zone_name === 'runeditrun.com')) {
      throw new Error('Target is not an enabled RunEditRun account Worker custom domain');
    }
    await requirePublicDns(hostname);
  }
  process.stdout.write(JSON.stringify(registry));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Registration failed'); process.exitCode = 1; });
