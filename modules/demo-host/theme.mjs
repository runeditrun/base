import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shared } from '../../cli/shared.mjs';
import { inlineTheme } from './theme-css.mjs';

const prefix = '/__demo/theme';

// Keep the Lobby's cascade (maintained defaults, seed fonts, seed theme), but
// resolve it at build time so the gate can paint without blocking CSS fetches.
export async function prepareTheme(folder, assets) {
  const { loadSeedTheme } = await shared('theme-files.mjs');
  const defaults = await loadSeedTheme(fileURLToPath(new URL('../../default-seed/', import.meta.url)), 'public/rer-theme.css');
  const paths = [], files = new Map(assets.map(file => ['/' + file.path, Buffer.from(file.base64, 'base64')]));
  for (const [path, file] of defaults.files) {
    const target = join(folder, 'assets', prefix, path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = file.type === 'text/css'
      ? Buffer.from(file.bytes.toString().replace(/url\((['"]?)(\/[^)'"\s]+)\1\)/g, (_, quote, url) => `url(${quote}${prefix}${url}${quote})`))
      : file.bytes;
    await writeFile(target, bytes);
    files.set(prefix + path, bytes);
    paths.push(prefix + path);
  }
  const seed = ['/fonts/fonts.css', '/rer-theme.css'].filter(path => files.has(path));
  // A seed theme without --rer-link links in its own --rer-text, as the theme
  // grammar reads it (onboarding/theme.mjs), never in the default's link colour.
  const link = files.has('/rer-theme.css') ? ':root{--rer-link:var(--rer-text)}' : '';
  return { paths, css: [inlineTheme(files, [prefix + '/rer-theme.css']), link, inlineTheme(files, seed)].join('\n') };
}
