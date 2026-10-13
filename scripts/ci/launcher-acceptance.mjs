// Exercise the existing packed-launcher suite against unchanged active source.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const temporary = process.env.RUNNER_TEMP;
if (!temporary) throw new Error('RUNNER_TEMP is required for CI launcher acceptance');
const manifest = resolve(temporary, 'launcher-release-manifest.json');
await writeFile(manifest, JSON.stringify({
  evidence: resolve(temporary, 'base-launcher-evidence'),
  playwrightModule: resolve('default-seed/node_modules/@playwright/test/index.mjs'),
  products: [{
    seed: 'happytohelp',
    repository: resolve(temporary, 'public-happytohelp'),
    commit: '60e9a84688ea41575d56a8f692bbb8173366c7c5',
    draft: { name: 'CI saved HappyToHelp choice' },
  }],
}));
execFileSync(process.execPath, ['launcher/tests/release-acceptance.mjs', manifest], { stdio: 'inherit' });
