import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Prefer the seed's small artwork, including the names shipped under brand/.
const small = ['favicon-32.svg', 'favicon.svg', 'icon.svg', 'favicon-32.png', 'favicon-32x32.png', 'favicon.png', 'icon-32.png', 'icon.png'];
const candidates = ['favicon.ico', 'brand/favicon.ico', ...small.flatMap(name => [name, `brand/${name}`]), 'apple-touch-icon.png', 'brand/apple-touch-icon.png', 'brand/mark.svg'];
const type = path => path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.ico') ? 'image/x-icon' : 'image/png';

/** Read once at build/installer start. Missing files never become browser probes. */
export async function readIconFiles(publicDirectory) {
 const files = new Map();
 for (const path of candidates) {
  try {
   // Do not export links outside public/ through a symbolic directory or file.
   const directory = await lstat(publicDirectory);
   if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('The public icon directory must be a regular directory.');
   if (path.startsWith('brand/')) {
    const brand = await lstat(join(publicDirectory, 'brand'));
    if (!brand.isDirectory() || brand.isSymbolicLink()) throw Error('The brand icon directory must be a regular directory.');
   }
   const stat = await lstat(join(publicDirectory, path));
   if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Icon ${path} must be a regular file.`);
   const bytes = await readFile(join(publicDirectory, path));
   if (path.endsWith('.png') && !path.includes('apple-touch-icon')) {
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 32 || bytes.readUInt32BE(20) !== 32) continue;
   }
   files.set('/' + path, { bytes, type: type(path) });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 const ico = ['favicon.ico', 'brand/favicon.ico'].find(path => files.has('/' + path));
 const favicon = small.flatMap(name => [name, `brand/${name}`]).find(path => files.has('/' + path));
 const apple = ['apple-touch-icon.png', 'brand/apple-touch-icon.png'].find(path => files.has('/' + path));
 const selected = [ico, favicon, apple].filter(Boolean);
 if (!selected.length && files.has('/brand/mark.svg')) selected.push('brand/mark.svg');
 const links = selected.map(path => `<link rel="${path.includes('apple-touch-icon') ? 'apple-touch-icon' : 'icon'}" href="/${path}"${path.includes('apple-touch-icon') ? '' : ` type="${type(path)}" sizes="${path.endsWith('.png') ? '32x32' : 'any'}"`}>`).join('');
 return { links, files: new Map(selected.map(path => ['/' + path, files.get('/' + path)])) };
}

/** Freeze the existing public icons into every shared server-rendered head. */
export function seedIcons() {
 return {
  name: 'rer:seed-icons',
  async config(config) {
   const publicDirectory = config.publicDir === false ? null : resolve(config.root ?? process.cwd(), config.publicDir ?? 'public');
   const icons = publicDirectory ? await readIconFiles(publicDirectory) : { links: '' };
   return { define: { __RER_ICON_HEAD__: JSON.stringify(icons.links) } };
  },
 };
}
