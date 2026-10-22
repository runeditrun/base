import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { nativeDeclarationSources } from './delivery-declarations.mjs';
import { RerError } from './errors.mjs';
/** Recovery cannot copy, rewind or reconstruct uncertain paid effects. */
export async function refuseAiRestore(root, ownerDeclaration) {
 for (const [path,select] of nativeDeclarationSources(ownerDeclaration)) {
  let value;
  try { value = JSON.parse(await readFile(await contained(root,path,{optional:true}),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw new RerError('ai_reconciliation_required','Restore requires readable native AI declarations; no installation state was changed.',4); }
  if (select(value)?.ai !== undefined) throw new RerError('ai_reconciliation_required','Installation restore with native AI is unsupported. Disable AI and reconcile the retained budget authority and image custody before restoring; archives do not rewind paid liability.',4);
 }
}
