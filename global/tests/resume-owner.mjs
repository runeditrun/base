import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep the real reference build, server and owner claim. Fail once at the
// owner hook, after private settings were saved, and require its input secret
// on every later claim just as a native password owner hook does.
export async function requireSavedOwnerInput(root) {
 const path = join(root, 'scripts/installer/local.mjs');
 const source = await readFile(path, 'utf8');
 await writeFile(path, `import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localInstaller } from '@runeditrun/rer/local-installer';
import { owner as claimOwner } from '@runeditrun/rer/adapter-auth';
` + source.replace('const lifecycle = operatorInstaller(', 'const originalLifecycle = operatorInstaller(').replace('export const adapter = lifecycle;', `
const lifecycle = { ...originalLifecycle, ...localInstaller({ ...originalLifecycle.hooks,
 async owner(context) {
  await writeFile(join(context.root, 'owner-hook-reached'), '');
  if (await access(join(context.root, 'fail-before-owner')).then(() => true, () => false)) throw context.fail('setup');
  if (!context.input.OWNER_PASSWORD || context.input.OWNER_PASSWORD !== context.vars.OWNER_PASSWORD) throw context.fail('setup');
  await claimOwner(context, originalLifecycle.hooks.owner);
 },
}), ownerBootstrap: originalLifecycle.ownerBootstrap };
export const adapter = lifecycle;`));
 await writeFile(join(root, 'fail-before-owner'), '');
}
