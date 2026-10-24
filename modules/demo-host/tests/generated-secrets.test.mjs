import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { secretHost, startCopy, fetchCopy } from './secret-host.mjs';

test('hosted encrypted-record visitors start independently, retain their keys across runtime restarts, and erase on teardown', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rer-secret-demo-')));
  let mf;
  try {
    const host = await secretHost(folder, { persist: join(folder, 'state') });
    mf = host.mf;
    const visitors = await Promise.all(['203.0.113.1', '203.0.113.2'].map(ip => startCopy(mf, ip)));
    for (const { response } of visitors) assert.equal(response.status, 303, await response.text());
    const info = await Promise.all(visitors.map(async ({ cookie }) => {
      const response = await fetchCopy(mf, '/key-info', cookie);
      assert.equal(response.status, 200, 'key metadata is available after start');
      return response.json();
    }));
    for (const row of info) {
      assert.equal(row.bytes, 32);
      assert.equal(row.length, 44);
      assert.equal(row.otherLength, 64);
      assert.equal(row.undeclared, true);
      assert.notEqual(row.digest, row.other);
    }
    assert.notEqual(info[0].digest, info[1].digest);
    await mf.dispose();
    mf = new Miniflare(host.options);
    for (const [index, { cookie }] of visitors.entries()) {
      const metadata = await fetchCopy(mf, '/key-info', cookie);
      assert.equal(metadata.status, 200, 'saved visitor is available after runtime restart');
      assert.deepEqual(await metadata.json(), info[index]);
      const company = await fetchCopy(mf, '/company', cookie);
      assert.equal(company.status, 200);
      assert.match(await company.text(), /October payroll · 6 people/);
      assert.ok((await (await fetchCopy(mf, '/export', cookie)).json()).company.data);
      assert.equal((await fetchCopy(mf, '/__demo/cancel', cookie, { method: 'POST' })).status, 204);
      assert.equal((await fetchCopy(mf, '/company', cookie)).status, 410);
    }
    const namespace = await mf.getDurableObjectNamespace('DEMO');
    for (const { cookie } of visitors) {
      const id = namespace.idFromString(cookie.match(/rer_demo=([^;]+)/)[1]);
      const storage = await mf.unsafeGetDurableObjectStorage('secret-test', 'NativeDemo', { id: id.toString() });
      assert.deepEqual(await storage.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA'"), []);
    }
  } finally { await mf?.dispose(); await rm(folder, { recursive: true, force: true }); }
});
