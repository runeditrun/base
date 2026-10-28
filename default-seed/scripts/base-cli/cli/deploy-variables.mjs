import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { deployConfigPaths } from './deploy-config.mjs';
import { parseJsonc } from './jsonc.mjs';
import { comments } from './business/parsers-syntax.mjs';
import { tomlEntries } from './business/parsers-config.mjs';
import { imageVariableSecrets } from '../modules/container/image-variables.mjs';

const id = 'deploy.vars-secrets';
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const variablePath = path => path[0] === 'vars' && path.length === 2 ||
 path[0] === 'env' && path[2] === 'vars' && path.length === 4;

async function sourceFile(root, path) {
 try { return await readFile(await contained(root, path, { optional: true }), 'utf8'); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Reuse the image builder's JSONC reader and binding comparison. Source checks
// deliberately reject even empty placeholders and legacy public-mail overlaps:
// a declaration belongs in vars or secrets, before any build normalizes it.
export async function deployVariableClause(root, adapter) {
 try {
  const declarationPath = adapter?.deploy?.declaration ?? 'deploy.json';
  const declarationSource = await sourceFile(root, declarationPath);
  if (declarationSource === null) return { id, ok: true };
  const secretLocations = new Map();
  const declaration = parseJsonc(declarationSource, (path, offset) => {
   if (path[0] === 'secrets' && path[2] === 'binding') secretLocations.set(path[1], lineAt(declarationSource, offset));
  });
  // deploy.json uses strict JSON in both native and container builds.
  try { JSON.parse(declarationSource); } catch { throw Error(`${declarationPath}: invalid JSON declaration.`); }
  const secrets = declaration.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some(secret => typeof secret?.binding !== 'string')) throw Error(`${declarationPath}: secrets must be an array of binding declarations.`);
  const overlaps = [];
  for (const path of deployConfigPaths(adapter)) {
   const source = await sourceFile(root, path);
   if (source === null) continue;
   const entries = [];
   let config;
   try {
    if (path.endsWith('.toml')) entries.push(...tomlEntries(comments(source).clean, { locations: true }));
    else config = parseJsonc(source, (path, offset) => entries.push({ path, offset }));
   } catch (error) { throw Error(`${path}: ${error.message}`); }
   for (const entry of entries.filter(entry => variablePath(entry.path))) {
    const binding = entry.path.at(-1);
    // TOML entries describe declared keys; JSONC values come from the very
    // same reader the node image builder uses (including escaped key names).
    const vars = config ? entry.path.slice(0, -1).reduce((value, key) => value?.[key], config) : { [binding]: entry.value };
    const matched = new Set(imageVariableSecrets(vars ?? {}, secrets).map(secret => secret.binding));
    if (!matched.has(binding)) continue;
    for (const [index, secret] of secrets.entries()) if (secret.binding === binding) overlaps.push(
      `${binding}: ${path}:${lineAt(source, entry.offset)} (${entry.path.slice(0, -1).join('.')}) and ${declarationPath}:${secretLocations.get(index)} (secrets)`);
   }
  }
  return overlaps.length ? { id, ok: false, message: overlaps.join('\n') + '\nremove it from wrangler vars; the deploy sets it as a secret' } : { id, ok: true };
 } catch (error) { return { id, ok: false, message: error.message }; }
}
