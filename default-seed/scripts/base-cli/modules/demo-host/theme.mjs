import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shared } from '../../cli/shared.mjs';

const prefix = '/__demo/theme';

// Ship the maintained default seed's actual theme, font and mark, rather than
// another set of fallback values. Namespace its assets so they cannot replace
// a seed's own files. The seed stylesheet follows it, just as in the Lobby;
// the browser resolves imports, token aliases and light/dark media rules.
export async function prepareTheme(folder, assets) {
  const { loadSeedTheme } = await shared('theme-files.mjs');
  const defaults = await loadSeedTheme(fileURLToPath(new URL('../../default-seed/', import.meta.url)), 'public/rer-theme.css');
  const paths = [];
  for (const [path, file] of defaults.files) {
    const target = join(folder, 'assets', prefix, path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = file.type === 'text/css'
      ? file.bytes.toString().replace(/url\((['"]?)(\/[^)'"\s]+)\1\)/g, (_, quote, url) => `url(${quote}${prefix}${url}${quote})`)
      : file.bytes;
    await writeFile(target, bytes);
    paths.push(prefix + path);
  }
  const has = path => assets.some(file => file.path === path);
  return { paths, stylesheets: [prefix + '/rer-theme.css', ...(has('fonts/fonts.css') ? ['/fonts/fonts.css'] : []), ...(has('rer-theme.css') ? ['/rer-theme.css'] : [])] };
}
