import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Vite's standalone runtime copy cannot depend on the CLI. Follow the same
// operations marker as the CLI; the host supplies its already loaded adapter.
async function inputPath(root, path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid-demo-input-path');
  let file = await realpath(root);
  for (const part of path.split('/')) {
    file = resolve(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('invalid-demo-input-path');
  }
  return file;
}

export async function demoRunDeclaration(declaration, { root, adapter, read } = {}) {
  if (declaration.runUrl !== undefined) return declaration;
  read ??= async path => JSON.parse(await readFile(await inputPath(root, path), 'utf8'));
  let bare = false;
  if (adapter === undefined) {
    let operations;
    try { operations = await read('OPERATIONS.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; bare = true; }
    if (operations?.seedContract) adapter = (await import(pathToFileURL(await inputPath(root, operations.seedContract.adapter)).href)).commandAdapter;
  }
  const path = adapter?.site?.declaration ?? (bare ? 'deploy-site.json' : undefined);
  if (!path) return declaration;
  let site;
  try { site = await read(path); }
  catch (error) { if (!bare || error.code !== 'ENOENT') throw error; }
  return site ? { ...declaration, runUrl: `https://${site.domain}/run` } : declaration;
}
