import { installD1Preflight } from '../../container/adapters/d1-workerd-setup.mjs';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { seedNative } from './consumer/fixtures.mjs';
import { context, signing } from './consumer/service.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = await readdir(join(root, 'node_modules/.pnpm'));
const wrangler = packages.find(name => name.startsWith('wrangler@4.129.1_'));
if (!wrangler) throw new Error('Install frozen workspace dependencies before running signing workerd tests.');
const require = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, D1_PLUGIN } = require('miniflare');
installD1Preflight(D1_PLUGIN);
const { build } = require('esbuild');
let compiled;

async function migration(db, name) {
  const sql = await readFile(new URL(`./consumer/migrations/${name}`, import.meta.url), 'utf8');
  let pending = sql.replace(/^--.*$/gm, '').trim();
  while (pending) {
    const end = pending.startsWith('CREATE TRIGGER') ? pending.indexOf('END;') + 4 : pending.indexOf(';') + 1;
    if (end <= 0) throw new Error(`Incomplete numbered migration ${name}`);
    await db.prepare(pending.slice(0, end)).run();
    pending = pending.slice(end).trim();
  }
  await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
}

export async function openSigningRuntime(options) {
  if (!['text-terms', 'pdf-html-signature'].includes(options.profile)) throw new TypeError(`Unsupported signing fixture profile: ${options.profile}`);
  compiled ??= (await build({ entryPoints: [fileURLToPath(new URL('./consumer/worker.mjs', import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022' })).outputFiles[0].text;
  const directory = await mkdtemp(join(tmpdir(), 'agreement-signing-'));
  const bindings = { PROFILE: options.profile, CREDENTIAL_KEY: randomBytes(32).toString('base64') };
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: compiled, compatibilityDate: '2026-09-01',
    d1Databases: { DB: 'signing-db' }, bindings }),
    resourcePersistencePath: resolve(directory, 'state') });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)').run();
    await migration(db, '0001_native_agreements.sql');
    const { fixture, identities } = await seedNative(db, options);
    await migration(db, '0002_agreement_signing.sql');
    await migration(db, '0003_preserve_populated_history.sql');
    // Private setup is finished before the real expiry interval starts. Migration
    // time on a loaded runner must not consume the participant's review window.
    if (options.expiresInMs) {
      fixture.definition.expiresAt = new Date(Date.now() + options.expiresInMs).toISOString();
      await db.prepare('UPDATE native_sources SET definition=? WHERE id=?').bind(JSON.stringify(fixture.definition), fixture.sourceId).run();
    }
    const call = (path, { input, actor = 'owner', key, method = input === undefined ? 'GET' : 'POST' } = {}) => mf.dispatchFetch(`https://signing.test${path}`, {
      method, headers: { Cookie: identities[actor]?.cookie ?? 'native_session=unknown',
        ...(key ? { 'Idempotency-Key': key } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const result = async response => ({ status: response.status, body: await response.json() });
    const native = async (path, input, actor = 'owner') => {
      const response = await call(path, { input, actor });
      if (!response.ok) throw new Error(`Native command ${path} refused ${response.status}: ${await response.text()}`);
      return response;
    };
    return {
      fixture,
      database: db,
      async signWithDatabase(input, { actor, key }, database) {
        const sessionId = identities[actor].cookie.split('=')[1];
        const session = await db.prepare('SELECT * FROM native_sessions WHERE id=?').bind(sessionId).first();
        return (await signing({ ...bindings, DB: database })).sign(context(session, fixture.sourceId, key), input);
      },
      async command(operation, input, { actor, key }) {
        let path;
        if (operation === 'prepare') path = `/offers/${encodeURIComponent(input.sourceId)}/agreements`;
        else if (operation === 'verify' || operation === 'restore') path = `/evidence/${operation}`;
        else {
          const id = operation === 'issue' ? input.id : operation === 'review' || operation === 'close' || operation === 'recordExternal' ? input.request.id : input.requestId;
          path = `/agreements/${encodeURIComponent(id)}/${operation === 'recordExternal' ? 'external' : operation}`;
        }
        return result(await call(path, { input, actor, key }));
      },
      async evidence(id, actor = 'owner') { return result(await call(`/agreements/${encodeURIComponent(id)}/evidence`, { actor })); },
      download(reference, actor = 'owner') { return call(`/files/${encodeURIComponent(reference.id)}/${encodeURIComponent(reference.version)}`, { actor }); },
      async nativeState() { return result(await call(`/offers/${fixture.sourceId}`)); },
      async reviseSource() {
        const { definition, fields } = await (await native(`/offers/${fixture.sourceId}/revise`, {})).json();
        fixture.definition = definition;
        fixture.binding.approvalDigest = definition.approvalDigest;
        fixture.binding.selectionDigest = definition.selectionDigest;
        fixture.binding.fields = fields;
      },
      async rotateSession(actor) {
        const response = await native('/sessions/rotate', {}, actor);
        identities[actor].cookie = response.headers.get('Set-Cookie').split(';')[0];
        fixture.sessionSecrets.push(identities[actor].cookie.split('=')[1]);
      },
      async revoke(actor) { await native('/access/revoke', { actorId: identities[actor].actorId }); },
      async failArtifactPut(fail) { await db.prepare("UPDATE native_settings SET value=? WHERE id='artifact-write-failure'").bind(String(fail)).run(); },
      async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await mf.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
