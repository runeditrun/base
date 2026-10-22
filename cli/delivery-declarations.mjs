import { readFile } from 'node:fs/promises';
import { validateDeclarations } from '../modules/delivery-producer/declarations.mjs';
import { contained } from './project.mjs';

// Source policy and its committed integration projection. Inspect declarations
// without requiring a build or executing the seed's packaging code.
export const deliveryDeclarationSources = [
 ['rer-packaging.json', value => value?.artifact?.specInputs],
 ['packaging.json', value => value?.artifact?.specInputs],
 ['scripts/delivery/base/packaging.json', value => value?.artifact?.specInputs],
 ['management/integration/deployment-spec.json', value => value],
 ['deploy.json', value => value],
];

export function nativeDeclarationSources(ownerDeclaration) {
 return typeof ownerDeclaration === 'string' && !deliveryDeclarationSources.some(([p]) => p === ownerDeclaration) ? [...deliveryDeclarationSources,[ownerDeclaration,value => value]] : deliveryDeclarationSources;
}

export async function deliveryDeclarationClauses(root, ownerDeclaration) {
 const clauses = [];
 for (const [path, select] of nativeDeclarationSources(ownerDeclaration)) {
  let text;
  try { text = await readFile(await contained(root, path, { optional: true }), 'utf8'); }
  catch (error) {
   if (error.code === 'ENOENT') continue;
   clauses.push({ id: `delivery.declarations.${path}`, ok: false, message: `Restore a readable contained declaration at ${path}.` });
   continue;
  }
  const clause = { id: `delivery.declarations.${path}`, ok: true };
  let value;
  try { value = JSON.parse(text); }
  catch { clause.ok = false; clause.message = `${path}: invalid JSON declaration.`; }
  if (clause.ok) {
   const spec = select(value);
   if (spec !== undefined) try {
    validateDeclarations(spec);
    if (spec.ai !== undefined) clauses.push({id:`delivery.ai.${path}`,ok:true});
   }
   catch (error) { clause.ok = false; clause.message = `${path}: ${error.message}`; if (spec?.ai !== undefined) clauses.push({id:`delivery.ai.${path}`,ok:false,message:'Restore the strict native AI declaration; installation approval is separate.'}); }
  }
  clauses.push(clause);
 }
 return clauses;
}
