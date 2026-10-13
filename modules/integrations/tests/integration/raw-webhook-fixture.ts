import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

export const key = new Uint8Array(32).fill(91); // Test-only key, not deployment custody.
export const tenant = 'installation', destinationId = 'receiver-v1';
export function signedWebhook(body: string, options: { id?: string; tenant?: string; destinationId?: string; now?: number } = {}) {
  const id = options.id ?? 'raw-event', audience = options.tenant ?? tenant;
  const destination = options.destinationId ?? destinationId, event = 'incident.opened';
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
  const canonical = JSON.stringify(['integrations.webhook.v1', audience, destination, event, id, timestamp, body]);
  return { body: new TextEncoder().encode(body), headers: {
    'webhook-id': id, 'webhook-tenant': audience, 'webhook-destination': destination,
    'webhook-event': event, 'webhook-timestamp': timestamp,
    'webhook-signature': `v1=${createHmac('sha256', key).update(canonical, 'utf8').digest('hex')}`,
  } };
}

export const byteMutations = [
  { name: 'malformed UTF-8 replacing a literal replacement character', original: '{"text":"\ufffd"}',
    body: new Uint8Array([...new TextEncoder().encode('{"text":"'), 0x80, ...new TextEncoder().encode('"}')]) },
  { name: 'inserted UTF-8 BOM', original: '{"text":"Café ☕"}',
    body: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"text":"Café ☕"}')]) },
];

/** Execute the documented receiver against the actual portable source in workerd.
 * Strip types only; imports and all runtime implementation remain unmodified. */
export async function receiverWorkerModules() {
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  const root = new URL('../../', import.meta.url);
  async function visit(url: URL): Promise<void> {
    const name = `modules/integrations/${url.href.slice(root.href.length)}`;
    if (modules[name]) return;
    const contents = stripTypeScriptTypes(await readFile(url, 'utf8'));
    modules[name] = { type: 'esm', contents };
    for (const match of contents.matchAll(/^(?:import|export)\s+(?:[^\n;]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      if (!match[1]!.startsWith('.')) throw new Error(`Nonportable receiver dependency: ${match[1]}`);
      await visit(new URL(match[1]!, url));
    }
  }
  await visit(new URL('index.ts', root));
  const guide = await readFile(new URL('receiver.md', root), 'utf8');
  const example = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1];
  if (!example) throw new Error('Missing documented receiver');
  modules['receiver.js'] = { type: 'esm', contents: stripTypeScriptTypes(example) };
  return modules;
}
