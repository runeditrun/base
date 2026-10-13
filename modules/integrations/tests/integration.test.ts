// The root verify:modules glob discovers only this file. Import every nested
// suite once here; do not also add nested globs to the root test command.
import { readdir } from 'node:fs/promises';
for (const unit of ['core', 'slack', 'helpers', 'integration']) {
  const directory = new URL(`./${unit}/`, import.meta.url);
  for (const name of (await readdir(directory)).sort()) {
    if (name.endsWith('.test.ts')) await import(new URL(name, directory).href);
  }
}
