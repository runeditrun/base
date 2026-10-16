import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Base's placeholder mark: the "F" every new foundation edition starts with
// (foundation/template/public/brand/mark.svg). `rer check` and run site builds
// warn while a seed carries it (a live run site's redeploy never breaks over
// it); `rer release` refuses it unless --allow-placeholder-mark is given. Base's
// own projects (the foundation template and the default seed) are exempt.
const placeholder = new Set(['c2c2a7325e51067c043bbd8a945e830ba6caeea4ca298615e310a931a58a181d']);
const baseProjects = new Set(['example/foundation', 'runeditrun/default-seed-reference']);
const image = /\.(svg|ico|png|webp|jpe?g|gif)$/i;
const skipped = new Set(['node_modules', '.git', '.wrangler', '.rer', '.seed', '.cache', 'dist', 'scripts/base-cli', 'scripts/base-onboarding']);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const placeholderMessage = files => `Base's placeholder mark is still in ${files.join(', ')}; replace with the seed's own mark.`;

/** One plain warning line (a JSON warning event under --json); never a failure. */
export function warnPlaceholderMarks(out, options, files) {
 if (!files.length) return;
 if (options.json) out.event('warning', { code: 'placeholder_mark', files, message: placeholderMessage(files) });
 else out.progress(`Warning: ${placeholderMessage(files)}\n`);
}

/** The image paths whose bytes are Base's placeholder mark, unless the project is Base's own. */
export async function placeholderMarks(project, paths, read) {
 if (baseProjects.has(project)) return [];
 const found = [];
 for (const path of paths) if (image.test(path) && placeholder.has(sha256(await read(path)))) found.push(path);
 return found.sort();
}

/** The checkout's own logo, favicon and app mark files carrying the placeholder. */
export async function checkoutPlaceholderMarks(root, project) {
 const paths = [];
 async function walk(path) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
   const name = path ? `${path}/${entry.name}` : entry.name;
   if (skipped.has(entry.name) || skipped.has(name)) continue;
   if (entry.isDirectory()) await walk(name);
   else if (entry.isFile()) paths.push(name);
  }
 }
 await walk('');
 return placeholderMarks(project, paths, path => readFile(join(root, path)));
}
