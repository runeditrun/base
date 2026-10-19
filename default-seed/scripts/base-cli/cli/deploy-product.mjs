import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

export class DeployProductError extends RerError {
 constructor(message) { super('safety_refusal', message, 4); }
}

// Omission preserves the owner's existing root product and command arguments.
export function deployProductDirectory(declaration) {
 const directory = declaration.productDirectory;
 if (directory === undefined) return;
 if (typeof directory !== 'string' || !directory || win32.isAbsolute(directory) || /^[A-Za-z]:/.test(directory) || /[\\\x00-\x1f\x7f]/.test(directory) || directory.split('/').some(part => !part || part === '.' || part === '..')) {
  throw new DeployProductError('Deploy productDirectory must be a normalized checkout-relative directory, without absolute paths, backslashes or traversal.');
 }
 return directory;
}

// Check after the build/hook: staging need not exist before it runs. contained
// checks every ancestor, so a symlink cannot redirect the packager outside.
export async function deployProductArguments(root, directory) {
 if (directory === undefined) return [];
 try {
  if (!(await stat(await contained(root, directory))).isDirectory()) throw new Error('not-directory');
 } catch {
  throw new DeployProductError('Deploy productDirectory must exist as a directory inside the checkout after the build or deploy hook; symlinks are refused.');
 }
 return ['--product', directory];
}
