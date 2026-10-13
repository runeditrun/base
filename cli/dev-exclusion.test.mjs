import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { DEV_LAYER_MARKER } from './dev-identity.mjs';
import { DEV_AI_MARKER } from './dev-identity.mjs';

const error = events => events.find(event => event.event === 'error');
async function files(path) {
 const found = [];
 for (const entry of await readdir(path, { withFileTypes: true })) found.push(...entry.isDirectory() ? await files(join(path, entry.name)) : [join(path, entry.name)]);
 return found;
}

test('rer build refuses a build that bundles the dev layer, naming the file; the real build has no marker', { timeout: 15 * 60_000 }, async t => {
 const seed = await portabilityFixture(t, { generated: false }), config = join(seed.root, 'wrangler.jsonc');
 const original = await readFile(config, 'utf8');
 // The classic mis-wiring: the deployed main points at the local-only entry.
 await writeFile(config, original.replace('"main": "src/server.ts"', '"main": "src/server.dev.ts"'));
 const refused = await seed.run(['build'], 4);
 assert.match(error(refused).message, /dist\/server\/[^ ]+\.js\b/);
 assert.match(error(refused).message, /local-only dev layer/);
 await writeFile(config, original);
 // AI alone is also refused, without the identity wrapper's marker.
 const entry = join(seed.root, 'src/server.ts'), production = await readFile(entry, 'utf8');
 await writeFile(entry, `import { withDevAi } from './modules/ai/dev/index.mjs';\n` + production.replace('export default withDemo({', 'const production = withDemo({') + '\nexport default withDevAi(production);\n');
 const aiRefused = await seed.run(['build'], 4);
 assert.match(error(aiRefused).message, /local-only dev layer/);
 await writeFile(entry, production);
 await seed.run(['build']);
 for (const file of await files(join(seed.root, 'dist'))) for (const marker of [DEV_LAYER_MARKER, DEV_AI_MARKER]) assert.equal((await readFile(file)).includes(marker), false, file);
 // rer check holds a devIdentity seed to its wiring and its email-link test.
 assert.ok((await seed.run(['check', '--profile', 'first-party'])).at(-1).clauses.every(clause => clause.ok));
 await rm(join(seed.root, 'tests/local-journey/journey.test.mjs'));
 const check = (await seed.run(['check', '--profile', 'first-party'], 1)).at(-1);
 assert.deepEqual(check.clauses.filter(clause => !clause.ok).map(clause => clause.id), ['SC-05.dev-identity.email-link-test']);
});

test('rer deploy and its dry run refuse RER_DEV_KEY, RER_DEMO and declared local-only keys before building', { timeout: 5 * 60_000 }, async t => {
 const seed = await portabilityFixture(t, { generated: false }), path = join(seed.root, 'deploy.json');
 const declaration = JSON.parse(await readFile(path, 'utf8'));
 for (const [change, key] of [
  [d => ({ ...d, secrets: [...d.secrets, { binding: 'RER_DEV_KEY', environment: 'RER_DEV_KEY' }] }), 'RER_DEV_KEY'],
  [d => ({ ...d, vars: { ...d.vars, RER_DEV_KEY: 'copied-from-local' } }), 'RER_DEV_KEY'],
  [d => ({ ...d, vars: { ...d.vars, RER_DEV_IDENTITY: 'on' } }), 'RER_DEV_IDENTITY'],
  [d => ({ ...d, vars: { ...d.vars, RER_DEMO: '1' } }), 'RER_DEMO'],
  [d => ({ ...d, vars: { ...d.vars, RER_MODELS_KEY: 'synthetic-live-dev-key' } }), 'RER_MODELS_KEY'],
  [d => ({ ...d, secrets: [...d.secrets, { binding: 'MODELS_KEY', environment: '.rer/local/models.json' }] }), '.rer/local/models.json'],
 ]) {
  await writeFile(path, JSON.stringify(change(declaration), null, 2));
  for (const args of [['deploy', '--dry-run'], ['deploy']]) {
   const refused = await seed.run(args, 4);
   assert.match(error(refused).message, new RegExp(`local-only key ${key}`));
  }
 }
 await assert.rejects(readdir(join(seed.root, 'dist')), 'refused before any build');
});
