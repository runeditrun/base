// `rer check` on a seed's CONTRACT.md: the Status table parses, and every
// evidence path it cites is in the checkout. A seed without CONTRACT.md has
// nothing to check here.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { ContractError, parseContract } from '../foundation/runtime/seed-contract.mjs';

const file = 'CONTRACT.md';

export async function contractStatusClauses(root) {
 let text;
 try { text = await readFile(join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 let contract;
 try { contract = parseContract(text, { file }); } catch (error) {
  if (!(error instanceof ContractError)) throw error;
  return error.problems.map(problem => ({ id: 'CONTRACT.status', ok: false, message: `${file}:${problem.line}: ${problem.message}` }));
 }
 const clauses = [{ id: 'CONTRACT.status', ok: true }];
 for (const clause of contract.clauses) for (const path of clause.evidence) {
  const inside = !isAbsolute(path) && !normalize(path).split(sep).includes('..');
  let exists = false;
  if (inside) try { await lstat(join(root, path)); exists = true; } catch {}
  clauses.push({ id: `CONTRACT.evidence.${clause.id}`, ok: exists, ...(!exists ? { message: `${file}:${clause.line}: ${clause.id} is ${clause.status} with evidence ${path}, which ${inside ? 'is not in this checkout' : 'is outside this repository'}.` } : {}) });
 }
 return clauses;
}
