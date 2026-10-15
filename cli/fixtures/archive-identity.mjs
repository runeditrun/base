import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { pause } from './reference.mjs';
import { localVariables } from '../../onboarding/local/environment.mjs';

const post = (origin, path, body, headers = {}) => fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function nativeSignIn(f, origin) {
 const settings = localVariables(await readFile(join(f.root, '.dev.vars'), 'utf8'));
 const proof = createHmac('sha256', settings.SESSION_SECRET).update('local-cli\0sign-in').digest('hex');
 const confirmed = await post(origin, '/auth/local/cli-session', { returnTo: '/app' }, { 'x-rer-local-cli': proof });
 assert.equal(confirmed.status, 303, 'local owner tooling obtains a fresh native session');
 const cookie = confirmed.headers.get('set-cookie')?.split(';')[0];
 assert.ok(cookie, 'confirmation issues a fresh native session');
 const response = await fetch(origin + '/auth/session', { headers: { Cookie: cookie } });
 assert.equal(response.status, 200);
 const session = await response.json();
 assert.equal(session.kind, 'native');assert.equal(session.operator.email, 'fresh-owner@example.test');assert.equal(session.operator.role, 'owner');
 return { cookie, session };
}

export async function archiveIdentityRuntime(f, origin, action) {
 const child = f.start(['dev', '--port', new URL(origin).port, '--json', '--non-interactive']);
 try {
  const deadline = Date.now() + 120000;
  while (!child.stdoutText.includes('"event":"ready"') && child.exitCode === null && Date.now() < deadline) await pause(100);
  assert.ok(child.stdoutText.includes('"event":"ready"'), 'archive identity runtime reaches readiness');
  return await action();
 } finally { await f.stop(child); }
}

export async function originalArchiveIdentity(f, origin) {
 return archiveIdentityRuntime(f, origin, async () => {
  const identity = await nativeSignIn(f, origin);
  const response = await fetch(origin + '/.well-known/rer-dependencies');
  assert.equal(response.status, 200, 'the real dependency document creates the installation sector and key');
  return { ...identity, sector: (await response.json()).sector_id };
 });
}

export async function recoverArchiveIdentity(f, origin, original, { retained = true } = {}) {
 await archiveIdentityRuntime(f, origin, async () => {
  assert.equal((await fetch(origin + '/auth/session', { headers: { Cookie: original.cookie } })).status, 401, 'the pre-export native session cannot authenticate after restore');
  const settings = localVariables(await readFile(join(f.root, '.dev.vars'), 'utf8'));
  const headers = { 'x-rer-local-cli': createHmac('sha256', settings.SESSION_SECRET).update('local-cli\0sign-in').digest('hex') };
  const claim = await post(origin, '/auth/bootstrap', { token: settings.SETUP_TOKEN, displayName: 'Another owner', returnTo: '/app' }, headers);
  assert.equal(claim.status, 409, 'the restored owner claim stays one-time');assert.equal((await claim.json()).error, 'already_initialized');
  assert.equal((await post(origin, '/auth/settings/identity', { idpSignIn: true }, { ...headers, Authorization: 'Bearer ' + settings.SETUP_TOKEN })).status, 401, 'a setup credential does not become owner authority');
  const recovered = await nativeSignIn(f, origin);
  if (retained) assert.deepEqual(recovered.session.operator, original.session.operator, 'native recovery returns the same person and owner authority');
  else {
   assert.notEqual(recovered.session.operator.id, original.session.operator.id, 'a moved default-seed has a freshly claimed owner');
   assert.equal(recovered.session.operator.email, original.session.operator.email);
   assert.equal(recovered.session.operator.role, 'owner');
  }
  const cookie = { Cookie: recovered.cookie };
  const finished = await fetch(origin + '/setup', { method: 'POST', redirect: 'manual', headers: { ...cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
  assert.equal(finished.status, 303);assert.equal(finished.headers.get('location'), '/app');
  assert.equal((await fetch(origin + '/app', { redirect: 'manual', headers: cookie })).status, 200, 'the restored app opens under the recovered native owner');
 });
}
