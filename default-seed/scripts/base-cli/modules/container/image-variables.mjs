import {readFile} from 'node:fs/promises';
import {deliveryDeclarationSources} from '../../cli/delivery-declarations.mjs';
import {sourcePath} from '../delivery-producer/migrations.mjs';
import {usesManagedMail,validateMailSpec} from '../delivery-producer/mail.mjs';

/** Drop empty runtime-secret placeholders; admit only managed-mail public legacy values. */
export async function checkImageVariables(root,vars,secrets) {
 const placeholders=secrets.filter(secret=>Object.hasOwn(vars,secret.binding) && vars[secret.binding] === '');
 const overlaps=secrets.filter(secret=>Object.hasOwn(vars,secret.binding) && vars[secret.binding] !== '');
 if (!overlaps.length) {
  for (const {binding} of placeholders) delete vars[binding];
  return;
 }
 const publicMail=new Set(),privateNames=new Set();
 for (const [candidate,select] of deliveryDeclarationSources) {
  const path=await sourcePath(root,candidate,{optional:true});
  if (!path) continue;
  const spec=select(JSON.parse(await readFile(path,'utf8')));
  if (!spec) continue;
  for (const name of [...(spec.secretNames ?? []),...(spec.optionalSecretNames ?? [])]) privateNames.add(name);
  if (!usesManagedMail(spec.mail)) continue;
  const names=spec.publicVariableNames ?? Object.keys(spec.publicVariables ?? {});
  const publicVariables=Object.fromEntries(Object.entries(vars).filter(([name])=>names.includes(name)));
  validateMailSpec({...spec,publicVariables,secretNames:spec.secretNames ?? []});
  for (const name of ['MAIL_PROVIDER','MAIL_FROM','MAIL_RELAY_URL']) if (typeof publicVariables[name] === 'string') publicMail.add(name);
 }
 for (const {binding} of overlaps) if (!publicMail.has(binding) || privateNames.has(binding)) {
  throw new Error('Secret declared as an image variable: '+binding);
 }
 for (const {binding} of placeholders) delete vars[binding];
 console.warn(overlaps.map(secret=>secret.binding).join(', ')+' are public mail configuration, not secrets. Remove these bindings from deploy.json secrets; keep them in the mail spec public variables and Wrangler vars. Accepting the legacy declaration; runtime demo settings override the image defaults.');
}
