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
CREATE TABLE fixture_reviews (id TEXT PRIMARY KEY, preparer_id TEXT NOT NULL REFERENCES oa_operators(id), reviewer_id TEXT REFERENCES oa_operators(id));
CREATE TABLE fixture_grants (id TEXT NOT NULL, scope TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES oa_operators(id), PRIMARY KEY(id,scope));
CREATE TABLE fixture_proofs (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, record_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE fixture_mail (email TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE fixture_installation (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
CREATE TABLE fixture_members (operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id), email TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL);
CREATE TABLE fixture_records (id TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), tls_required INTEGER NOT NULL DEFAULT 1, operator_id TEXT NOT NULL REFERENCES oa_operators(id));
CREATE TABLE fixture_receipts (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES fixture_records(id), kind TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES oa_operators(id), created_at INTEGER NOT NULL);
`;

export async function buildFixture(root) {
 const require = createRequire(join(base, 'default-seed/package.json'));
 return require('esbuild').build({ metafile: true, entryPoints: [join(import.meta.dirname, 'worker.mjs')], outfile: join(root, 'dist/server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'fixture-credentials', setup(build) {
   build.onResolve({ filter: /^\.\/credentials\.mjs$/ }, () => ({ path: join(root, 'credentials.mjs') }));
  } }],
 });
}

export async function fixtureSeed(t, mode, { sponsors = false, security = false } = {}) {
 const root = await mkdtemp(join(tmpdir(), 'rer-agent-door-'));
 t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
 await mkdir(join(root, 'dist/server/migrations'), { recursive: true });
 await mkdir(join(root, 'dist/client'), { recursive: true });
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'));
 // Generate once per installation; both isolated Workers read the same values.
 await writeFile(join(root, 'credentials.mjs'),
  `export const deliverySecret = ${JSON.stringify(randomBytes(32).toString('hex'))};\n`
  + `export const openAiAuthorization = ${JSON.stringify('Bearer ' + randomBytes(32).toString('hex'))};\n`);
 for (const file of ['provider.mjs', 'receiver.mjs', 'initializer.mjs', 'proof.mjs', 'confirm-mail.mjs', 'journey.mjs', 'secret-source.mjs', 'second-sponsor.mjs', 'inbound-webhook.mjs', 'reviewer-owner.mjs', 'reviewer.mjs']) await cp(join(import.meta.dirname, file), join(root, file));
 const surface = JSON.parse(await readFile(join(import.meta.dirname, 'surface.json'), 'utf8'));
 surface.verification = { journey: 'journey.mjs', proof: { module: 'proof.mjs' }, network: { module: 'provider.mjs', secretSource: 'secret-source.mjs', origins: ['https://api.openai.com', 'https://receiver.example.invalid'] },
  ...(['native', 'native-reviewer'].includes(mode) ? { owner: { email: 'native-owner@example.com', emailField: 'SETUP_OPERATOR_EMAIL', initializer: mode === 'native-reviewer' ? 'reviewer-owner.mjs' : 'initializer.mjs' } } : {}),
  ...(mode === 'native-reviewer' ? { reviewers: [{ label: 'quality', email: 'native-reviewer@example.invalid', initializer: 'reviewer.mjs' }] } : {}),
  ...(mode === 'signed' ? { owner: { bindings: { RER_MANAGEMENT_ORIGIN: 'issuer', RER_INSTALLATION_ID: 'installationId' } } } : {}),
 };
 if (sponsors) {
  surface.verification.sponsors = [{ label: 'owner' }, { label: 'member', email: 'synthetic-member@example.com', initializer: 'second-sponsor.mjs' }];
  for (const [name, readOnly] of [['read', true], ['update', false]]) surface.tools.push({ name: `fixture.records.${name}`, scope: readOnly ? 'records:read' : 'records:write', readOnly, classes: ['standard'], clauses: ['BASE-AGENT-002'] });
  const reference = { id: { $from: 'create', pointer: '/id' } };
  const read = { id: 'read-private', tool: 'fixture.records.read', args: reference, expect: [{ class: 'standard' }] };
  const change = { id: 'edit-private', tool: 'fixture.records.update', args: { ...reference, value: 'Private revised note' }, expect: [{ class: 'standard' }] };
  surface.journey.splice(1, 0, read, change);
  surface.verification.crossSponsor = { prepare: ['create'], read, change };
 }
 if (security) {
  surface.tools.push(
   { name: 'fixture.workspace.snapshot', scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-006'] },
   { name: 'fixture.access.invite', scope: 'access:write', readOnly: false, classes: ['external', 'access'], clauses: ['BASE-AGENT-006'] },
   { name: 'fixture.access.role', scope: 'access:write', readOnly: false, classes: ['access'], clauses: ['BASE-AGENT-006'] },
  );
  surface.witness = { tool: 'fixture.workspace.snapshot', args: {} };
  surface.escalations = [
   { id: 'invite-self', tool: 'fixture.access.invite', args: { email: { $sponsor: 'email' }, name: 'Sponsor', role: 'admin' } },
   { id: 'widen-self', tool: 'fixture.access.role', args: { id: { $sponsor: 'id' }, role: 'admin' } },
  ];
  surface.journey.push(
   { id: 'invite', tool: 'fixture.access.invite', args: { email: 'synthetic-teammate@example.com', name: 'Teammate', role: 'member' }, expect: [{ class: 'external', facts: { counterparty: 'new' } }, { class: 'access', facts: { direction: 'widens' } }] },
   { id: 'widen', tool: 'fixture.access.role', args: { id: { $from: 'invite', pointer: '/id' }, role: 'admin' }, expect: [{ class: 'access', facts: { direction: 'widens' } }] },
   { id: 'narrow', tool: 'fixture.access.role', args: { id: { $from: 'invite', pointer: '/id' }, role: 'member' }, expect: [{ class: 'access', facts: { direction: 'narrows' } }] },
   { id: 'witness', tool: 'fixture.workspace.snapshot', args: {}, expect: [{ class: 'standard' }] },
  );
  surface.verification.replayAdmission = { prepare: ['create'] };
  surface.verification.webhooks = { module: 'inbound-webhook.mjs', prepare: ['create'] };
  surface.tools.push({ name: 'fixture.security.tls', scope: 'records:write', readOnly: false, classes: ['security'], clauses: ['BASE-AGENT-006'], authority: 'none',
   effect: { kind: 'record', justification: 'Updates only fixture_records.tls_required; no person, role, scope, grant or credential is accepted.' },
   inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, required: { type: 'boolean' } }, required: ['id', 'required'] },
  });
  surface.journey.splice(1, 0, { id: 'tls', tool: 'fixture.security.tls', args: { id: { $from: 'create', pointer: '/id' }, required: true }, expect: [{ class: 'security', facts: { measure: 1, setting: 'record-tls' } }] });
 }
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
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, vars: { OWNER_MODE: mode, ...(sponsors ? { SPONSOR_PROOF: true } : {}), ...(security ? { SECURITY_PROOF: true } : {}) }, secrets: [{ binding: 'SESSION_SECRET' }, { binding: 'MAIL_API_KEY' }] }));
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'fixture', migrations_dir: 'migrations' }] }));
 const schemas = [...await Promise.all(productionSchemas.map(file => readFile(join(base, file), 'utf8'))), nativeSchema];
 for (const [i, sql] of schemas.entries()) await writeFile(join(root, `dist/server/migrations/${String(i + 1).padStart(4, '0')}.sql`), sql);
 return realpath(root);
}
