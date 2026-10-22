import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { RerError } from './errors.mjs';
/** Recovery cannot copy, rewind or reconstruct uncertain paid effects. */
export async function refuseAiRestore(root) {
 for (const [path,select] of deliveryDeclarationSources) {
  let value;
  try { value = JSON.parse(await readFile(await contained(root,path,{optional:true}),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (select(value)?.ai !== undefined) throw new RerError('ai_reconciliation_required','Installation restore with native AI is unsupported. Disable AI and reconcile the retained budget authority and image custody before restoring; archives do not rewind paid liability.',4);
 }
}
