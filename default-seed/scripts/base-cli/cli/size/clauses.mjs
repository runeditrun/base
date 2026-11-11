import { RerError } from '../errors.mjs';
import { readSizeDeclaration } from './declaration.mjs';

/** `rer check` clauses for a seed's size-check.json: SC-15.size.<field path>. */
export async function sizeCheckClauses(root, adapter) {
 let result;
 try { result = await readSizeDeclaration(root, adapter); }
 catch (error) {
  if (!(error instanceof RerError)) throw error;
  return [{ id: 'SC-15.size.declaration', ok: false, message: error.message }];
 }
 if (!result.present) return [{ id: 'SC-15.size.undeclared', ok: true }];
 if (!result.problems.length) return [{ id: 'SC-15.size.declaration', ok: true }];
 // One clause per field path; two problems on one field share its clause.
 const byPath = new Map();
 for (const { path, message } of result.problems) byPath.set(path, [...(byPath.get(path) ?? []), message]);
 return [...byPath].map(([path, messages]) => ({
  id: path ? `SC-15.size.${path}` : 'SC-15.size.declaration', ok: false,
  message: `size-check.json ${path || '(file)'}: ${messages.join(' ')}`,
 }));
}
