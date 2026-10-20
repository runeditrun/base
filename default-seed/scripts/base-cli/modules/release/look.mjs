import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';

export const defaultLook = Object.freeze({
  home: ['public/brand/**', 'src/branding.json', 'public/rer-theme.css', 'public/fonts/**', 'src/site/**', '!src/site/docs/**'],
  app: ['public/brand/**', 'src/branding.json', 'public/**/*.{css,js,mjs,html}', 'src/ui/**', 'src/**/*.css', 'src/client/**'],
});

export function lookFingerprints(source) {
  const declared = source.entries.has('rer-project.json') ? JSON.parse(source.bytes('rer-project.json')).look : undefined;
  if (declared !== undefined && (!declared || typeof declared !== 'object' || Array.isArray(declared) || Object.keys(declared).some(key => !['home', 'app'].includes(key))))
    throw Error('rer-project.json look must declare home and/or app glob arrays');
  return Object.fromEntries(['home', 'app'].map(kind => {
    const globs = declared?.[kind] ?? defaultLook[kind];
    if (!Array.isArray(globs) || !globs.every(glob => typeof glob === 'string' && glob.replace(/^!/, '') && !/[\\\0\r\n]/.test(glob) && !glob.replace(/^!/, '').startsWith('/') && !glob.split('/').includes('..')))
      throw Error('Look globs must be repository-relative patterns');
    const includes = globs.filter(glob => !glob.startsWith('!')), excludes = globs.filter(glob => glob.startsWith('!')).map(glob => glob.slice(1));
    const hash = createHash('sha256');
    for (const path of [...source.entries.keys()].sort()) {
      const entry = source.entries.get(path);
      if (entry.type === 'blob' && includes.some(glob => matchesGlob(path, glob)) && !excludes.some(glob => matchesGlob(path, glob)))
        hash.update(`${path}\0${entry.oid}\n`);
    }
    return [kind, `sha256:${hash.digest('hex')}`];
  }));
}
