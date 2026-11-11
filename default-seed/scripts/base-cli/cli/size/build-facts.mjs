import { readFile } from 'node:fs/promises';
import { contained } from '../project.mjs';
import { parseJsonc } from '../jsonc.mjs';
import { deployConfigPaths } from '../deploy-config.mjs';
import { declaredCrons } from '../scheduled.mjs';
import { defaultBuild } from './build-paths.mjs';


async function readOptional(root, path) {
 try { return await readFile(await contained(root, path, { optional: true }), 'utf8'); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// `binding = "DB"` inside [[d1_databases]] tables or an inline d1_databases list.
function tomlD1Bindings(source) {
 const names = [];
 let inside = false;
 for (const line of source.split('\n').map(text => text.replace(/^\s*#.*/, ''))) {
  const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*$/.exec(line);
  if (header) { inside = header[1] === 'd1_databases'; continue; }
  const inline = /^\s*d1_databases\s*=\s*(.*)$/.exec(line);
  if (inline) for (const match of inline[1].matchAll(/binding\s*=\s*"([^"]+)"/g)) names.push(match[1]);
  else if (inside) { const match = /^\s*binding\s*=\s*"([^"]+)"/.exec(line); if (match) names.push(match[1]); }
 }
 return names;
}

function jsonD1Bindings(config) {
 return (Array.isArray(config.d1_databases) ? config.d1_databases : []).map(entry => entry?.binding).filter(name => typeof name === 'string');
}

// What a checkout declares that a size-check.json is checked against: its Cron Triggers and D1 bindings, read from
// the files `rer check` and `rer dev` already read (deploy-config.mjs), the deploy declaration and the optional build
// wrangler file. Nothing is built or run. `problems` lists files that cannot be read, each as { path, message }.
export async function buildFacts(root, adapter, build = {}) {
 const crons = new Set(), bindings = new Set(), problems = [];
 try { for (const cron of await declaredCrons(root, adapter)) crons.add(cron); }
 catch (error) { problems.push({ path: 'flows', message: `The checkout's declared crons cannot be read (${error.message}); fix its wrangler or deploy configuration.` }); }
 const wrangler = [...deployConfigPaths(adapter), build.wrangler ?? defaultBuild.wrangler];
 for (const path of new Set(wrangler)) {
  let source;
  try { source = await readOptional(root, path); }
  catch { problems.push({ path: 'build', message: `${path} cannot be read inside the checkout; point build.wrangler at a file in it.` }); continue; }
  if (source === null) continue;
  try { for (const name of /\.toml$/.test(path) ? tomlD1Bindings(source) : jsonD1Bindings(parseJsonc(source))) bindings.add(name); }
  catch (error) { problems.push({ path: 'build', message: `${path} is not valid configuration (${error.message}); fix it.` }); }
 }
 const deployPath = build.deployDeclaration ?? defaultBuild.deployDeclaration;
 try {
  const source = await readOptional(root, deployPath);
  if (source !== null) {
   const declaration = JSON.parse(source);
   for (const entry of Array.isArray(declaration.d1) ? declaration.d1 : []) if (typeof entry?.binding === 'string') bindings.add(entry.binding);
   for (const cron of Array.isArray(declaration.crons) ? declaration.crons : []) if (typeof cron === 'string') crons.add(cron);
  }
 } catch { problems.push({ path: 'build', message: `${deployPath} cannot be read as JSON inside the checkout; point build.deployDeclaration at the deploy declaration.` }); }
 return { crons: [...crons], bindings: [...bindings], problems };
}
