import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PINS = Object.freeze({ '@playwright/test': '1.63.0', '@axe-core/playwright': '4.13.0', 'axe-core': '4.13.0' });

function packageVersion(require, name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return manifest.version;
    } catch { /* A package entry can live below its package root. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name} package metadata`);
    directory = parent;
  }
}

export function resolveVersions(cwd) {
  const require = createRequire(resolve(cwd, 'package.json'));
  let actual;
  try {
    const axeRequire = createRequire(require.resolve('@axe-core/playwright'));
    actual = {
      '@playwright/test': packageVersion(require, '@playwright/test'),
      '@axe-core/playwright': packageVersion(require, '@axe-core/playwright'),
      'axe-core': packageVersion(axeRequire, 'axe-core'),
    };
  } catch {
    throw new Error(`Review dependencies unavailable; expected ${Object.entries(PINS).map(([name, version]) => `${name} ${version}`).join(', ')}`);
  }
  if (Object.entries(PINS).some(([name, version]) => actual[name] !== version)) {
    throw new Error(`Review version mismatch: expected ${Object.entries(PINS).map(([name, version]) => `${name} ${version}`).join(', ')}; resolved ${Object.entries(actual).map(([name, version]) => `${name} ${version}`).join(', ')}`);
  }
  return { pinned: PINS, actual };
}

export function loadDependencies(cwd) {
  const versions = resolveVersions(cwd);
  const require = createRequire(resolve(cwd, 'package.json'));
  const axe = require('@axe-core/playwright');
  return { ...versions, chromium: require('@playwright/test').chromium, AxeBuilder: axe.default ?? axe };
}
