import { readFile } from 'node:fs/promises';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { sourcePath } from '../modules/delivery-producer/migrations.mjs';
import { usesManagedMail } from '../modules/delivery-producer/mail.mjs';

// Managed-capable seeds can retain direct-provider adapters. Only declared
// mail credentials receive stand-ins; other application secrets still need
// their own deploy declaration, even when packaging lists them.
const credentials = new Set(['MAIL_API_KEY', 'MAIL_PROVIDER_API_KEY', 'RESEND_API_KEY', 'SENDGRID_API_KEY']);

export async function hostedMailCredentials(root) {
 const names = new Set();
 for (const [candidate, select] of deliveryDeclarationSources) {
  const path = await sourcePath(root, candidate, { optional: true });
  if (!path) continue;
  const spec = select(JSON.parse(await readFile(path, 'utf8')));
  if (!spec || !usesManagedMail(spec.mail)) continue;
  for (const name of [...(spec.secretNames ?? []), ...(spec.optionalSecretNames ?? [])]) {
   if (credentials.has(name)) names.add(name);
  }
 }
 return [...names];
}
