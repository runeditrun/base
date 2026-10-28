import { runCases } from './cases.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeReturnTo, normalizeEmail, isActiveOperator, defaultRolePolicy, requireLoopback } from '../index.mjs';
import { hashToken, opaqueToken, validToken } from '../crypto.mjs';
import { configure } from '../config.mjs';
const owner = { id: 'o', email: 'owner@example.com', role: 'owner', status: 'active' };
const admin = { ...owner, id: 'a', role: 'admin' };
const member = { ...owner, id: 'm', role: 'member' };
test('return paths retain valid query/fragment and reject URL/control/encoding redirects', async t => {

  await runCases(t, [
['encoded return path', async t => {
  assert.equal(safeReturnTo('/app/projects?q=one%20two#today'), '/app/projects?q=one%20two#today');
}],
['fragment return path', async t => {
  assert.equal(safeReturnTo('/app/projects?sort=recent#today'), '/app/projects?sort=recent#today');
}],
['unsafe return path variants', async t => {
  await runCases(t, Array.from(['https://evil.test', '//evil.test', '/\\evil.test', '/%2fevil.test', '/%252fevil.test', '/%5cevil.test', '/%0aLocation:evil', '/\n', 'javascript:alert(1)', '/%zz'], (input, rowIndex) => [`${t.name}: input row ${rowIndex + 1}`, async t => {
assert.equal(safeReturnTo(input), '/app', input);
}]));
}]
  ]);
});
test('normalization, allow list, active policy and default role hierarchy', async t => {

  await runCases(t, [
['normalized owner email', async t => {
  assert.equal(normalizeEmail(' OWNER@Example.COM '), 'owner@example.com');
}],
['invalid email variants', async t => {
  await runCases(t, Array.from(['invalid', 'a@example.com\r\nbcc:x@y.z', 'a b@example.com', null], (input, rowIndex) => [`${t.name}: input row ${rowIndex + 1}`, async t => {
assert.throws(() => normalizeEmail(input));
}]));
}],
['empty allow list refuses', async t => {
  assert.equal(isActiveOperator(owner, []), false);
}],
['inactive owner refuses', async t => {
  assert.equal(isActiveOperator({ ...owner, status: 'inactive' }), false);
}],
['admin cannot invite owner', async t => {
  assert.equal(defaultRolePolicy({ actor: admin, action: 'operators:invite', role: 'owner' }), false);
}],
['admin may invite member', async t => {
  assert.equal(defaultRolePolicy({ actor: admin, action: 'operators:invite', role: 'member' }), true);
}],
['member may revoke own sessions', async t => {
  assert.equal(defaultRolePolicy({ actor: member, target: member, action: 'sessions:revoke' }), true);
}],
['member cannot revoke owner sessions', async t => {
  assert.equal(defaultRolePolicy({ actor: member, target: owner, action: 'sessions:revoke' }), false);
}],
['admin cannot deactivate owner', async t => {
  assert.equal(defaultRolePolicy({ actor: admin, target: owner, action: 'operators:deactivate' }), false);
}]
  ]);
});
test('review requires literal URL and Host; forwarded headers confer no trust', async (t) => {
  await runCases(t, [['literal host scenarios', async t => {
  await runCases(t, Array.from(['localhost', '127.0.0.1', '[::1]'], (host, rowIndex) => [`${t.name}: allowed literal host row ${rowIndex + 1}`, async t => {
assert.doesNotThrow(() => requireLoopback(new Request(`http://${host}:8787`, { headers: { Host: `${host}:8787` } })));
}]));
  await runCases(t, Array.from(['evil.test', 'localhost.evil.test', '127.0.0.2', 'localhost:99'], (host, rowIndex) => [`${t.name}: refused Host row ${rowIndex + 1}`, async t => {
assert.throws(() => requireLoopback(new Request('http://localhost:8787', { headers: { Host: host, 'X-Forwarded-Host': 'localhost:8787' } })), { status: 403 });
}]));
  assert.throws(() => requireLoopback(new Request('https://evil.test', { headers: { Host: 'localhost', Forwarded: 'host=localhost' } })), { status: 403 });

  }]]);
});
test('cryptographic tokens and strict config are domain-separated and fail closed', async t => {

  const token = opaqueToken();
  const config = { origin: 'https://auth.test', OWNER_EMAIL: 'owner@example.com', SESSION_SECRET: 'x'.repeat(32) };
  await runCases(t, [
['valid opaque token', async t => { assert.ok(validToken(token));
}],
['fresh tokens differ', async t => { assert.notEqual(token, opaqueToken());
}],
['token domains differ', async t => {
  assert.notEqual(await hashToken('secret', 'link', token), await hashToken('secret', 'session', token));
}],
['host cookie configuration', async t => {
  assert.equal(configure(config).cookieName, '__Host-operator_session');
}],
['invalid configuration variants', async t => {
  await runCases(t, Array.from([{ origin: 'http://auth.test' }, { origin: 'https://auth.test/path' }, { local: true }, { sessionSeconds: 0 }, { SESSION_SECRET: 'short' }, { externalIssuers: ['http://issuer.test'] }], (patch, rowIndex) => [`${t.name}: patch row ${rowIndex + 1}`, async t => {
assert.throws(() => configure({ ...config, ...patch }));
}]));
}]
  ]);
});
