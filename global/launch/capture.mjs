import { open } from 'node:fs/promises';
import { readDevKey } from '../../cli/dev-identity.mjs';
import { createRedaction, credentialValues } from '../../onboarding/redaction.mjs';

// The generated key is not in the launcher's environment. Setup may create it
// after capture begins, so register it before each queued write until it exists.
export function launchRedaction(root, env = process.env) {
 const redaction = createRedaction({ wrappedSecrets: true });
 redaction.addSecrets(credentialValues(env));
 let key;
 const clean = value => typeof value === 'string' ? redaction.redact(value)
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item)])) : value;
 return {
  ...redaction, clean,
  async refresh() { if (!key) { key = await readDevKey(root); if (key) redaction.addSecrets([key]); } },
 };
}

// Both server streams and preparation output pass here before reaching disk.
// JSON is redacted by value, preserving parseable progress events.
export async function captureFile(root, path, env = process.env) {
 const redaction = launchRedaction(root, env), file = await open(path, 'a', 0o600);
 let queued = Promise.resolve(), writes = Promise.resolve();
 const append = text => { writes = writes.then(() => file.appendFile(text)); void writes.catch(() => {}); };
 const stream = redaction.stream(append);
 const queue = action => { queued = queued.then(async () => { await redaction.refresh(); action(); }); void queued.catch(() => {}); };
 return {
  write(text) { queue(() => stream.write(text)); },
  line(text) {
   let event; try { event = JSON.parse(text); } catch {}
   if (event && typeof event === 'object') queue(() => append(JSON.stringify(redaction.clean(event)) + '\n'));
   else queue(() => stream.write(text + '\n'));
  },
  async close() { try { await queued; stream.end(); await writes; } finally { await file.close(); } },
 };
}
