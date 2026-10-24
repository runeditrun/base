import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { secretHost, startCopy, fetchCopy } from './secret-host.mjs';
class Capture extends Log {
  constructor(messages) { super(LogLevel.VERBOSE); this.messages = messages; }
  log(message) { this.messages.push(String(message)); }
}
const diagnostics = async (mf, correlation) => {
  const namespace = await mf.getDurableObjectNamespace('CAPACITY');
  return JSON.parse(JSON.stringify(await namespace.get(namespace.idFromName('diagnostics')).diagnostic(correlation)));
};
test('a refused owner claim cannot retain a generated key straddling the old truncation boundary', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rer-claim-secrecy-'))), logs = [];
  let mf;
  try {
    const host = await secretHost(folder, { entry: 'secret-failure-app.mjs', settings: { FAILURE_MODE: 'claim' }, persist: join(folder, 'state'), log: new Capture(logs), handleStructuredLogs: log => logs.push(log.message) });
    mf = host.mf;
    const { response } = await startCopy(mf, '203.0.113.20');
    assert.equal(response.status, 502);
    const correlation = response.headers.get('x-rer-demo-correlation');
    const saved = await diagnostics(mf, correlation);
    assert.ok(saved?.failure, 'the failure remains diagnosable');
    const retained = JSON.stringify([saved, logs, await response.text()]);
    assert.ok(!retained.includes('sha256='), 'no seed response text is retained');
    assert.doesNotMatch(retained, /\.{385}[A-Za-z0-9+/]{43}/, 'no recoverable partial key reaches any sink');
    await mf.dispose(); mf = new Miniflare(host.options);
    assert.deepEqual(await diagnostics(mf, correlation), saved, 'the persisted diagnostic is the sanitized one');
  } finally { await mf?.dispose(); await rm(folder, { recursive: true, force: true }); }
});
test('a generated visitor key in a real seed alarm exception never reaches host logs', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rer-alarm-secrecy-'))), logs = [];
  let mf;
  try {
    ({ mf } = await secretHost(folder, { entry: 'secret-failure-app.mjs', log: new Capture(logs), handleStructuredLogs: log => logs.push(log.message) }));
    const { response, cookie } = await startCopy(mf, '203.0.113.21');
    assert.equal(response.status, 303);
    const namespace = await mf.getDurableObjectNamespace('DEMO');
    const id = namespace.idFromString(cookie.match(/rer_demo=([^;]+)/)[1]);
    const runtime = await namespace.get(id).session(), key = runtime.ENVELOPE_RECORD_KEY;
    assert.equal((await fetchCopy(mf, '/arm', cookie)).status, 200);
    for (let n = 0; n < 150 && !logs.some(line => line.includes('native-demo-seed-alarm-failed')); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(logs.some(line => line.includes('native-demo-seed-alarm-failed')), 'the real seed alarm failed');
    for (let offset = 0; offset <= key.length - 8; offset++) assert.ok(!logs.some(line => line.includes(key.slice(offset, offset + 8))), 'no generated key fragment is logged');
    assert.equal((await fetchCopy(mf, '/__demo/cancel', cookie, { method: 'POST' })).status, 204);
  } finally { await mf?.dispose(); await rm(folder, { recursive: true, force: true }); }
});
