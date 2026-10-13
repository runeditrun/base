import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as forward } from 'node:http';
import { createAiClient, aiConfig, AiError } from '../index.mjs';
import { createAiOutbox, createDevAiClient } from '../dev/index.mjs';
import { createFakeTransport } from '../fake/index.mjs';
import { runtime, DEV_KEY } from './runtime.mjs';

test('dev text and JSON answer through Worker HTTP, stream native text, and persist each capture', async t => {
  const f = await runtime(t);
  let calls = 0;
  const answer = (path, options) => { calls++; return f.call(path, options); };
  for (const [path, input, textOf] of [
    ['/__dev/ai/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }, x => x.choices[0].message.content],
    ['/__dev/ai/v1/responses', { input: 'hello' }, x => x.output[0].content[0].text],
  ]) {
    const body = { model: 'test-model', ...input }, headers = { 'x-models-feature': 'analytics' };
    const first = await (await answer(path, { body, headers })).json();
    assert.equal(typeof textOf(first), 'string'); assert.ok(textOf(first).trim());
    assert.equal(textOf(await (await answer(path, { body, headers })).json()), textOf(first));
    const transcript = await (await answer(path, { body: { ...body, stream: true }, headers })).text();
    const events = transcript.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const chunks = events.filter(x => path.endsWith('responses') ? x.type === 'response.output_text.delta' : x.choices?.[0]?.delta?.content !== undefined);
    assert.equal(chunks.map(x => path.endsWith('responses') ? x.delta : x.choices[0].delta.content).join(''), textOf(first));
    assert.ok(events.some(x => x.usage || x.response?.usage));
    const format = path.endsWith('responses') ? { text: { format: { type: 'json_object' } } } : { response_format: { type: 'json_object' } };
    const jsonAnswer = async () => JSON.parse(textOf(await (await answer(path, { body: { ...body, ...format } })).json()));
    const value = await jsonAnswer();
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(await jsonAnswer(), value);
  }
  const before = await (await f.call('/__dev/ai')).json();
  assert.equal(before.length, calls); assert.ok(before.every(x => x.request && x.response && x.usage));
  await f.restart();
  assert.deepEqual(await (await f.call('/__dev/ai')).json(), before);
});

test('dev embeddings depend on each input and preserve batch order', async t => {
  const f = await runtime(t), path = '/__dev/ai/v1/embeddings';
  const embed = async input => (await (await f.call(path, { body: { model: 'embedding', input, dimensions: 12 } })).json()).data;
  const batch = await embed(['alpha', 'beta']);
  assert.deepEqual(batch.map(x => x.embedding), [(await embed('alpha'))[0].embedding, (await embed('beta'))[0].embedding]);
  assert.notDeepEqual(batch[0].embedding, batch[1].embedding);
  assert.ok(batch.every(x => x.embedding.length === 12 && x.embedding.every(Number.isFinite)));
});

test('schema output and forced tools fail visibly and enter the outbox', async t => {
  const f = await runtime(t);
  for (const [path, body] of [
    ['/__dev/ai/v1/chat/completions', { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } } }],
    ['/__dev/ai/v1/responses', { text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } } }],
    ['/__dev/ai/v1/chat/completions', { tool_choice: { type: 'function', function: { name: 'answer' } } }],
  ]) {
    const response = await f.call(path, { body: { model: 'test-model', ...body } });
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'dev_fake_cannot_answer');
  }
  assert.ok((await (await f.call('/__dev/ai')).json()).every(x => x.error?.code === 'dev_fake_cannot_answer' && !x.response));
});

test('every dev HTTP surface and product dev call needs the key, including behind a forwarding proxy', async t => {
  const f = await runtime(t), target = await f.url;
  const proxy = createServer((req, res) => {
    const upstream = forward(new URL(req.url, target), { method: req.method, headers: { ...req.headers, host: target.host, 'x-forwarded-for': '203.0.113.7' } }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  for (const path of ['/__dev/ai', '/__dev/ai/v1/chat/completions', '/__dev/ai/v1/responses', '/__dev/ai/v1/embeddings']) {
    const options = path === '/__dev/ai' ? {} : { method: 'POST', body: JSON.stringify({ model: 'fake', input: 'private' }) };
    assert.equal((await fetch(url + path, options)).status, 404);
    assert.equal((await f.call(path, { key: 'wrong' })).status, 404);
    assert.equal((await f.call(path, { headers: { 'x-test-production': 'true' } })).status, 404);
  }
  assert.deepEqual(await (await f.call('/__dev/ai')).json(), []);
  const exchange = await f.call('/__dev/key', { key: null, body: { key: DEV_KEY }, headers: { 'content-type': 'application/json' } });
  assert.equal(exchange.status, 204);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.call('/__dev/ai', { key: null, cookie })).status, 200);
  assert.equal((await f.call('/__dev/ai', { key: null, cookie: cookie + '; ' + cookie })).status, 404);
  const outbox = { async put() { assert.fail('unauthorized capture'); }, async list() { return []; } };
  const client = createDevAiClient({ enabled: true }, { request: new Request('http://127.0.0.1/app'), key: DEV_KEY, origin: 'http://127.0.0.1', local: true, outbox });
  await assert.rejects(client.chat({ model: 'test' }), error => error instanceof AiError && error.status === 404);
});

test('direct and linked client calls preserve wire content, stream and usage with exactly one upstream attempt', async t => {
  let hits = 0, received;
  const server = createServer(async (req, res) => {
    hits++; let text = ''; for await (const chunk of req) text += chunk;
    received = { body: text ? JSON.parse(text) : undefined, url: req.url, headers: req.headers };
    if (received.body?.model === 'redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end(); return; }
    res.writeHead(200, { 'content-type': text && JSON.parse(text).stream ? 'text/event-stream' : 'application/json', 'x-models-target': 'openai/exact', 'x-models-request': 'receipt_123', 'x-models-cost-microusd': '17' });
    res.end(text && JSON.parse(text).stream ? 'data: {"usage":{"output_tokens":3}}\n\ndata: [DONE]\n\n' : '{"usage":{"input_tokens":7,"output_tokens":3}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`, body = { model: 'openai/exact', messages: [{ role: 'user', content: 'untouched' }], tools: [{ type: 'function', function: { name: 'action', parameters: { type: 'object' } } }] };
  for (const [name, prefix] of [['direct', '/v1'], ['direct', '/edge/openai'], ['models', '']]) {
    const client = createAiClient({ enabled: true, [name]: { baseUrl: baseUrl + prefix, apiKey: 'test-only-key' } });
    for (const [operation, input, path] of [['chat', body, '/v1/chat/completions'], ['responses', { model: body.model, input: 'untouched', stream: true }, '/v1/responses'], ['embeddings', { model: body.model, input: ['one', 'two'] }, '/v1/embeddings']]) {
      const before = hits, result = await client[operation](input, { feature: 'analysis' });
      assert.equal(hits, before + 1); assert.equal(received.url, name === 'direct' ? prefix + path.slice(3) : path); assert.deepEqual(received.body, input);
      assert.equal(received.headers['x-models-feature'], name === 'models' ? 'analysis' : undefined);
      assert.equal(received.headers.authorization, 'Bearer test-only-key');
      if (input.stream) assert.match(await result.text(), /output_tokens/);
      else assert.deepEqual((await result.json()).usage, { input_tokens: 7, output_tokens: 3 });
    }
    if (name === 'models') { await client.receipt('receipt_123'); assert.equal(received.url, '/v1/receipts/receipt_123'); assert.equal(received.headers['x-models-feature'], undefined, 'the app key supplies its default feature when none is specified'); }
    const before = hits;
    await assert.rejects(client.chat({ model: 'redirect', messages: [] }), error => error instanceof AiError);
    assert.equal(hits, before + 1, 'redirect is refused without a second credential-bearing request');
  }
});

test('the caller aborts an in-flight provider stream without a second attempt', async t => {
  let hits = 0, disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"delta":"started"}\n\n'); res.once('close', disconnected); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const controller = new AbortController();
  const client = createAiClient({ enabled: true, direct: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-only-key' } });
  const response = await client.chat({ model: 'test-model', messages: [], stream: true }, { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await assert.rejects(reader.read()); await closed;
  assert.equal(hits, 1);
});

test('AI remains off until enabled and ambiguous feature transports fail without dispatch; explicit direct features work', async () => {
  let hits = 0;
  const transport = { baseUrl: 'https://provider.example/v1', apiKey: 'fixture-key' };
  const dependencies = { fetch: async () => { hits++; return Response.json({ usage: {} }); } };
  const off = createAiClient(aiConfig({ MODELS_SERVICE: transport.baseUrl, MODELS_KEY: transport.apiKey }), dependencies);
  await assert.rejects(off.chat({ model: 'fast' }), { code: 'ai_disabled' });
  const client = createAiClient({ enabled: true, direct: transport, models: transport, features: { image: 'direct' } }, dependencies);
  for (const operation of ['chat', 'responses', 'embeddings']) await assert.rejects(client[operation]({ model: 'fast' }), { code: 'ai_misconfigured' });
  assert.equal(hits, 0);
  await client.chat({ model: 'image-provider' }, { feature: 'image' }); assert.equal(hits, 1);
  const urls = [];
  for (const env of [{}, { AI_BASE_URL: '' }]) {
    const configured = createAiClient(aiConfig({ AI_ENABLED: 'true', AI_API_KEY: 'fixture-key', ...env }), { fetch: async url => { urls.push(url); return Response.json({ usage: {} }); } });
    await configured.chat({ model: 'test-model' });
  }
  assert.equal(urls.length, 2); assert.equal(urls[0], urls[1], 'blank optional URL is equivalent to omitted');
});

test('pinned targets cannot be silently substituted and failed sends never retry or expose provider errors', async () => {
  const config = { enabled: true, models: { baseUrl: 'https://models.example', apiKey: 'fixture-key' } };
  let hits = 0, cancelled = false;
  const client = createAiClient(config, { fetch: async () => { hits++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'x-models-target': 'openai/different' } }); } });
  await assert.rejects(client.chat({ model: 'openai/exact', stream: true }), { code: 'ai_target_mismatch' });
  assert.equal(hits, 1); assert.equal(cancelled, true);
  for (const response of [() => { throw Error('fixture-key private upstream text'); }, () => Response.json({ error: { code: 'budget_exhausted', message: 'fixture-key' } }, { status: 402 }), () => Response.json({ error: { code: 'fixture-key', message: 'fixture-key' } }, { status: 500 })]) {
    hits = 0;
    const failing = createAiClient(config, { fetch: async () => { hits++; return response(); } });
    await assert.rejects(failing.responses({ model: 'fast' }), error => error instanceof AiError && !error.message.includes('fixture-key') && !error.code.includes('fixture-key'));
    assert.equal(hits, 1);
  }
});

test('live dev accepts schema calls and captures only receipt metadata; scripted fake supplies exact fixtures', async t => {
  const f = await runtime(t), db = await f.db, outbox = createAiOutbox({ db });
  const key = DEV_KEY, request = new Request('http://127.0.0.1/app', { headers: { 'x-rer-dev-key': key } });
  const dependencies = { request, key, origin: 'http://127.0.0.1', local: true, outbox, live: { baseUrl: 'https://models.example', apiKey: 'fixture-key' }, fetch: async () => new Response('private-output-sentinel', { headers: { 'x-models-request': 'receipt_1', 'x-models-cost-microusd': '9' } }) };
  const result = await createDevAiClient({ enabled: true }, dependencies).responses({ model: 'smart', input: 'private-input-sentinel', text: { format: { type: 'json_schema' } } }, { feature: 'analytics' });
  assert.equal(await result.text(), 'private-output-sentinel');
  const rows = await outbox.list();
  assert.equal(rows[0].receipt['x-models-request'], 'receipt_1');
  assert.ok(!JSON.stringify(rows).includes('sentinel'));
  const scripted = createAiClient({ enabled: true, direct: { baseUrl: 'http://127.0.0.1', apiKey: 'fixture' } }, { transport: createFakeTransport({ script: async () => Response.json({ output: 'supplied fixture' }) }) });
  assert.deepEqual(await (await scripted.responses({ model: 'test' })).json(), { output: 'supplied fixture' });
  await db.prepare('DROP TABLE rer_ai_development_outbox').run();
  let hits = 0, cancelled = false;
  const failedCapture = createDevAiClient({ enabled: true }, { ...dependencies, fetch: async () => {
    hits++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'x-models-request': 'receipt_failed_capture' } });
  } });
  await assert.rejects(failedCapture.responses({ model: 'smart', input: 'private-input-sentinel', stream: true }), error => error instanceof AiError && error.code === 'dev_outbox_unavailable');
  assert.equal(hits, 1); assert.equal(cancelled, true, 'failed capture closes the live body without a new upstream attempt');
});
