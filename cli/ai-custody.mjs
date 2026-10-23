import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { RerError } from './errors.mjs';
import { DENY, admit, refuseAi } from '../modules/ai/native/names.mjs';
// Every file an installation could declare native AI in: the delivery declarations and the owner deploy declaration.
const nativeDeclarationSources = ownerDeclaration => [...deliveryDeclarationSources,
 ...[...new Set(['deploy.json', ...(typeof ownerDeclaration === 'string' ? [ownerDeclaration] : [])])].map(path => [path, value => value])];
/** Recovery cannot copy, rewind or reconstruct uncertain paid effects. */
export async function refuseAiRestore(root, ownerDeclaration) {
 for (const [path,select] of nativeDeclarationSources(ownerDeclaration)) {
  let value;
  try { value = JSON.parse(await readFile(await contained(root,path,{optional:true}),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw new RerError('ai_reconciliation_required','Restore requires readable native AI declarations; no installation state was changed.',4); }
  if (select(value)?.ai !== undefined) throw new RerError('ai_reconciliation_required','Installation restore with native AI is unsupported. Disable AI and reconcile the retained budget authority and image custody before restoring; archives do not rewind paid liability.',4);
 }
}
/** A rer command with no approved AI route (container commands, the hosted demo, rer verify and every
 * local command's settings) refuses an `ai` declaration and every reserved runtime name before it starts. */
export function refuseNativeAi(command, declaration, bindings = []) {
 try { refuseAi(declaration, command); admit(DENY, bindings); }
 catch (error) {
  if (!['ai_hosting_unproven', 'ai_policy_conflict'].includes(error.code)) throw error;
  throw new RerError(error.code, error.code === 'ai_hosting_unproven'
   ? `${command}: refused the deploy declaration's ai; only rer deploy to your own Cloudflare account serves native AI (ai_hosting_unproven).`
   : `${command}: refused ${error.resource}; only rer deploy derives RER_AI_ names, from an approved ai declaration (ai_policy_conflict).`, 4, { resource: error.resource });
 }
}
