// `rer check` on a seed's CONTRACT.md: the Status table parses, and every
// evidence path it cites is in the checkout. A seed without CONTRACT.md has
// nothing to check here.
//
// One exception, and only in a managed copy: the platform installs a published
// release without the publisher's repository automation (everything under
// `.github/workflows`, plus `.github/dependabot.yml`), so an evidence path in
// that set cannot be in the copy. A checkout is a managed copy only when it
// carries the platform's committed release record, `rer-upstream.json`, exactly
// as the platform writes it (a regular file, schema 1, and exactly the keys
// repository, tag and commit). Every other path stays a hard check there, and
// an authoring checkout checks everything.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { ContractError, parseContract } from '../foundation/runtime/seed-contract.mjs';

const file = 'CONTRACT.md';
const releaseRecord = 'rer-upstream.json';
const automation = /^\.github\/(?:workflows(?:\/|$)|dependabot\.ya?ml$)/;

async function isManagedCopy(root) {
 try {
  const path = join(root, releaseRecord);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 4096) return false;
  const value = JSON.parse(await readFile(path, 'utf8'));
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'commit,repository,schema,tag'
   && value.schema === 1 && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value.repository)
   && /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.tag) && /^[a-f0-9]{40}$/i.test(value.commit);
 } catch { return false; }
}

export async function contractStatusClauses(root) {
 let text;
 try { text = await readFile(join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 let contract;
 try { contract = parseContract(text, { file }); } catch (error) {
  if (!(error instanceof ContractError)) throw error;
  return error.problems.map(problem => ({ id: 'CONTRACT.status', ok: false, message: `${file}:${problem.line}: ${problem.message}` }));
 }
 const clauses = [{ id: 'CONTRACT.status', ok: true }];
 const managed = await isManagedCopy(root);
 for (const clause of contract.clauses) for (const path of clause.evidence) {
  const inside = !isAbsolute(path) && !normalize(path).split(sep).includes('..');
  if (managed && inside && automation.test(normalize(path).split(sep).join('/'))) {
   clauses.push({ id: `CONTRACT.evidence.${clause.id}`, ok: true, message: `${file}:${clause.row}: ${clause.id} evidence ${path} is publisher repository automation, skipped in a managed copy.` });
   continue;
  }
  let exists = false;
  if (inside) try { await lstat(join(root, path)); exists = true; } catch {}
  clauses.push({ id: `CONTRACT.evidence.${clause.id}`, ok: exists, ...(!exists ? { message: `${file}:${clause.row}: ${clause.id} is ${clause.status} with evidence ${path}, which ${inside ? 'is not in this checkout' : 'is outside this repository'}.` } : {}) });
 }
 return clauses;
}
