import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const base = resolve(import.meta.dirname, '../../../..');
const source = path => pathToFileURL(join(base, path)).href;
const productionSchemas = [
 'modules/operator-auth/accounts/schema/operator-auth.sql',
 'modules/owner-claim/schema/owner-claim.sql',
 'modules/business-settings/schema/0001_business_settings.sql',
 'modules/business-settings/schema/0002_business_people.sql',
 'modules/agent-door/schema/agent-door.sql',
];
const nativeSchema = `
CREATE TABLE fixture_members (operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id), email TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL);
CREATE TABLE fixture_records (id TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), operator_id TEXT NOT NULL REFERENCES oa_operators(id));
CREATE TABLE fixture_receipts (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES fixture_records(id), kind TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES oa_operators(id), created_at INTEGER NOT NULL);
CREATE TABLE fixture_reviews (id TEXT PRIMARY KEY, preparer_id TEXT NOT NULL REFERENCES oa_operators(id), reviewer_id TEXT REFERENCES oa_operators(id));
`;

export async function buildFixture(root) {
 const require = createRequire(join(base, 'default-seed/package.json'));
 await require('esbuild').build({ entryPoints: [join(import.meta.dirname, 'worker.mjs')], outfile: join(root, 'dist/server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'fixture-credentials', setup(build) {
   build.onResolve({ filter: /^\.\/credentials\.mjs$/ }, () => ({ path: join(root, 'credentials.mjs') }));
  } }],
 });
}

export async function fixtureSeed(t, mode) {
 const root = await mkdtemp(join(tmpdir(), 'rer-agent-door-'));
 t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
 await mkdir(join(root, 'dist/server/migrations'), { recursive: true });
 await mkdir(join(root, 'dist/client'), { recursive: true });
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'));
 // Generate once per installation; both isolated Workers read the same values.
 await writeFile(join(root, 'credentials.mjs'),
  `export const deliverySecret = ${JSON.stringify(randomBytes(32).toString('hex'))};\n`
  + `export const mailApiKey = ${JSON.stringify(randomBytes(32).toString('hex'))};\n`
  + `export const openAiAuthorization = ${JSON.stringify('Bearer ' + randomBytes(32).toString('hex'))};\n`);
 for (const file of ['provider.mjs', 'receiver.mjs', 'initializer.mjs', 'reviewer-owner.mjs', 'reviewer.mjs']) await cp(join(import.meta.dirname, file), join(root, file));
 const surface = JSON.parse(await readFile(join(import.meta.dirname, 'surface.json'), 'utf8'));
 surface.verification = { network: { module: 'provider.mjs', origins: ['https://api.openai.com', 'https://receiver.example.invalid'] },
  ...(['native', 'native-reviewer'].includes(mode) ? { owner: { email: 'native-owner@example.com', emailField: 'SETUP_OPERATOR_EMAIL', initializer: mode === 'native-reviewer' ? 'reviewer-owner.mjs' : 'initializer.mjs' } } : {}),
  ...(mode === 'native-reviewer' ? { reviewers: [{ label: 'quality', email: 'native-reviewer@example.invalid', initializer: 'reviewer.mjs' }] } : {}),
 };
 await writeFile(join(root, 'agent-surface.json'), JSON.stringify(surface));
 const reference = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', engines: reference.engines, packageManager: reference.packageManager }));
 await writeFile(join(root, '.node-version'), reference.engines.node + '\n');
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/agent-fixture', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' },
  commands: { verify: { argv: ['node', 'build-fixture.mjs'], inputs: ['build-fixture.mjs'], effects: 'Build the real fixture Worker for hosted conformance.' } },
 }));
 await writeFile(join(root, 'build-fixture.mjs'), `import { buildFixture } from ${JSON.stringify(import.meta.url)}; await buildFixture(process.cwd());\n`);
 await writeFile(join(root, 'adapter.mjs'), `import { localInstaller } from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify(source('cli/adapter.mjs'))};
export const commandAdapter = declare(localInstaller({}), { verify: [process.execPath, ['build-fixture.mjs']], publicPages: ['/'] });\n`);
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Fixture installation', fields: [
  { name: 'OWNER_EMAIL', kind: 'email', required: true }, { name: 'SETUP_TOKEN', kind: 'secret', required: true, generate: 'hex' },
 ], steps: ['native', 'native-reviewer'].includes(mode) ? [{ type: 'extension', id: 'lamp-native-owner' }] : [{ type: 'owner-claim', mode, emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: mode === 'signed' ? '/auth/owner-claim' : '/auth/bootstrap' }] }));
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, vars: { OWNER_MODE: mode }, secrets: [{ binding: 'SESSION_SECRET' }] }));
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'fixture', migrations_dir: 'migrations' }] }));
 const schemas = [...await Promise.all(productionSchemas.map(file => readFile(join(base, file), 'utf8'))), nativeSchema];
 for (const [i, sql] of schemas.entries()) await writeFile(join(root, `dist/server/migrations/${String(i + 1).padStart(4, '0')}.sql`), sql);
 return realpath(root);
}
