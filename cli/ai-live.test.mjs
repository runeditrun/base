import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { retainStartupFailure } from './fixtures/command-diagnostic.mjs';

test('rer dev selects the double or a stdin-keyed Models dev app explicitly; live outbox contains receipts only', { timeout: 5 * 60_000 }, async t => {
  const seed = await portabilityFixture(t, { generated: false });
  await seed.run(['setup', '--owner-email', 'ai-owner@example.test']);
  const key = (await readFile(join(seed.root, '.rer/local/dev-key.env'), 'utf8')).trim().slice('RER_DEV_KEY='.length);
  const devAppKey = 'mdl_synthetic_expiring_capped_dev_app_key';
  let hits = 0;
  const models = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${devAppKey}`);
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'cheap', providers: ['test-provider'] }] })); return; }
    hits++; let input = ''; for await (const chunk of req) input += chunk;
    assert.equal(JSON.parse(input).text.format.type, 'json_schema');
    res.writeHead(200, { 'content-type': 'application/json', 'x-models-request': 'receipt_live' });
    res.end(JSON.stringify({ output: 'private-live-output-sentinel', usage: { input_tokens: 3 } }));
  });
  await new Promise(resolve => models.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => models.close(resolve)));
  const service = `http://127.0.0.1:${models.address().port}`;
  let child;
  t.after(async () => { if (child?.exitCode === null) { child.kill('SIGTERM'); await child.done; } });
  async function start(flags, stdin = '') {
    child = spawn(process.execPath, ['scripts/rer.mjs', 'dev', '--json', ...flags], { cwd: seed.root, env: { ...process.env, CI: 'true', RER_NODE_AUTO: '0', WRANGLER_SEND_METRICS: 'false' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdoutText = ''; child.stderrText = '';
    child.stdout.on('data', chunk => { text += chunk; child.stdoutText += chunk; }); child.stderr.on('data', chunk => { child.stderrText += chunk; });
    child.done = new Promise(resolve => child.once('close', resolve)); child.stdin.end(stdin);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && child.exitCode === null) {
      const ready = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(x => x.event === 'ready');
      if (ready) return ready.url;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await retainStartupFailure(seed.root, child);
    throw Error('Dev did not become ready; captured private diagnostics suppressed.');
  }
  async function stop() { child.kill('SIGTERM'); await child.done; child = undefined; }
  async function call(url, path, body) { return fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'x-rer-dev-key': key }, body: body ? JSON.stringify(body) : undefined }); }
  const schema = { model: 'cheap', input: 'private-live-input-sentinel', text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } } };
  const liveUrl = await start(['--models', 'live', '--models-service', service], devAppKey + '\n');
  assert.equal((await stat(join(seed.root, '.rer/local/models.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(seed.root, '.rer/local'))).mode & 0o777, 0o700);
  const result = await call(liveUrl, '/__dev/ai/v1/responses', schema);
  assert.equal(result.status, 200); assert.equal((await result.json()).output, 'private-live-output-sentinel'); assert.equal(hits, 1);
  const rows = await (await call(liveUrl, '/__dev/ai')).json();
  assert.equal(rows[0].receipt['x-models-request'], 'receipt_live'); assert.ok(!JSON.stringify(rows).includes('sentinel'));
  await stop();
  const fakeUrl = await start([]);
  const refused = await call(fakeUrl, '/__dev/ai/v1/responses', schema);
  assert.equal(refused.status, 422); assert.equal((await refused.json()).error.code, 'dev_fake_cannot_answer'); assert.equal(hits, 1);
  await stop();
});
