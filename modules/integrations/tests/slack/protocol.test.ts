import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySlackBot, classifySlackIncomingWebhook, createSlackBotProtocol, createSlackIncomingWebhookProtocol, createSlackNotifier, renderSlackEvent, serializeSlackMessage, slackEventTemplates, SLACK_BOT_PROTOCOL, SLACK_WEBHOOK_PROTOCOL } from '../../slack/index.ts';
import { NodePinnedTransport } from '../../core/node-transport.ts';
import { botToken, channel, durableFixture, successBot, webhookUrl, wireFixture } from './fixture.ts';

const message = renderSlackEvent('incident.updated', { title: 'Local', detail: 'Update' }, slackEventTemplates);
const base = { id: 'local-1', tenant: 'installation', destinationId: 'destination-v1', event: 'incident.updated' };
const webhook = () => ({ ...base, protocol: SLACK_WEBHOOK_PROTOCOL, body: serializeSlackMessage(message) });
const bot = () => ({ ...base, protocol: SLACK_BOT_PROTOCOL, body: serializeSlackMessage(message, channel) });

test("Slack protocols preserve explicit destination authority and conservative provider outcomes", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['webhook success is exact; documented failures reject; unknown server/redirect responses stay uncertain', async (t) => {
  const cases: [number, string, string][] = [
    [200, 'ok', 'accepted'], [200, 'ok\n', 'uncertain'], [201, 'ok', 'uncertain'],
    [200, '{"ok":true}', 'uncertain'], [204, '', 'uncertain'],
    [400, 'invalid_payload', 'rejected'], [403, 'action_prohibited', 'rejected'],
    [404, 'channel_not_found', 'rejected'], [410, 'channel_is_archived', 'rejected'],
    [500, 'rollup_error', 'uncertain'], [503, '', 'uncertain'], [302, 'ok', 'uncertain'],
    [400, 'unknown-secret-detail', 'uncertain'], [200, 'invalid_token', 'uncertain'],
  ];
  await runCases(t, Array.from(cases, ([status, body, kind], rowIndex) => [`${t.name}: [status, body, kind] row ${rowIndex + 1}`, async t => {
assert.equal(classifySlackIncomingWebhook({ status, body, headers: {} }).kind, kind, `${status} ${body}`);
}]));
}]);
foldedCases.push(['bot requires boolean ok; HTTP 200 errors, partial failures and untrusted response details are distinguished', async (t) => {
  const cases: [number, string, string, string][] = [
    [200, successBot, 'accepted', 'slack_bot_accepted'],
    [200, '{"ok":false,"error":"invalid_auth"}', 'rejected', 'slack_invalid_auth'],
    [200, '{"ok":false,"error":"channel_not_found"}', 'rejected', 'slack_channel_not_found'],
    [200, '{"ok":false,"error":"missing_scope"}', 'rejected', 'slack_missing_scope'],
    [200, '{"ok":false,"error":"internal_error"}', 'uncertain', 'slack_internal_error'],
    [200, '{"ok":false,"error":"fatal_error"}', 'uncertain', 'slack_fatal_error'],
    [200, '{"ok":false,"error":"service_unavailable"}', 'uncertain', 'slack_bot_response_unknown'],
    [200, JSON.stringify({ ok: false, error: botToken }), 'uncertain', 'slack_bot_response_unknown'],
    [200, '{"ok":"true"}', 'uncertain', 'slack_bot_response_unknown'],
    [200, '{"ok":true,"error":"invalid_auth"}', 'uncertain', 'slack_bot_response_unknown'],
    [200, 'null', 'uncertain', 'slack_bot_invalid_response'], [200, 'broken', 'uncertain', 'slack_bot_invalid_response'],
    [500, successBot, 'uncertain', 'slack_bot_http_unknown'], [302, successBot, 'uncertain', 'slack_bot_http_unknown'],
  ];
  await runCases(t, Array.from(cases, ([status, body, kind, code], rowIndex) => [`${t.name}: [status, body, kind, code] row ${rowIndex + 1}`, async t => {
assert.deepEqual(classifySlackBot({ status, body, headers: {} }), { kind, code, status });
}]));
}]);
foldedCases.push(['rate limits parse seconds case-insensitively without inventing cooldowns', async (t) => {
  await runCases(t, Array.from([classifySlackBot, classifySlackIncomingWebhook], (classify, rowIndex) => [`${t.name}: classify row ${rowIndex + 1}`, async t => {
    assert.deepEqual(classify({ status: 429, body: '', headers: { 'Retry-After': '7' } }), { kind: 'retryable', code: 'slack_rate_limited', status: 429, retryAfterMs: 7000 });
    await runCases(t, Array.from(['', '-1', 'tomorrow', '1.5', 'Infinity', '99999999999999999999999999'], (value, rowIndex) => [`${t.name}: value row ${rowIndex + 1}`, async t => {
assert.equal(classify({ status: 429, body: '', headers: { 'retry-after': value } }).kind, 'rejected');
}]));
    assert.equal(classify({ status: 429, body: '', headers: { 'retry-after': '3', 'Retry-After': '4' } }).kind, 'rejected');
}]));
  await runCases(t, Array.from(['rate_limited', 'ratelimited'], (error, rowIndex) => [`${t.name}: error row ${rowIndex + 1}`, async t => {
assert.equal(classifySlackBot({ status: 200, body: JSON.stringify({ ok: false, error }), headers: { 'retry-after': '3' } }).retryAfterMs, 3000);
}]));
}]);
foldedCases.push(['trusted configuration binds webhook host and bot channel; errors redact credentials', async (t) => {
  const urls = [
    'https://evil.example/services/a/b/c', 'http://hooks.slack.com/services/a/b/c',
    'https://hooks.slack.com.evil.example/services/a/b/c', 'https://fixture-hooks.slack.com@evil.example/services/a/b/c',
    'https://hooks.slack.com:444/services/a/b/c', 'https://hooks.slack.com/services/a/b/c?token=secret',
    'https://hooks.slack.com/services/a/b/c#secret', 'https://127.0.0.1/services/a/b/c',
    'https://169.254.169.254/services/a/b/c', 'https://hooks.slack.com/services/a/b/%2fsecret',
    'https://hooks.slack.com/services/a/b/c/extra',
  ];
  await runCases(t, Array.from(urls, (url, rowIndex) => [`${t.name}: url row ${rowIndex + 1}`, async t => {
await assert.rejects(createSlackIncomingWebhookProtocol({ resolveDestination: async () => url }).prepare(webhook(), 0), /^Error: Slack webhook configuration unavailable or invalid$/);
}]));
  await runCases(t, Array.from([
    () => createSlackIncomingWebhookProtocol({ resolveDestination: async () => { throw new Error(webhookUrl); } }).prepare(webhook(), 0),
    () => createSlackBotProtocol({ resolveDestination: async () => { throw new Error(botToken); } }).prepare(bot(), 0),
  ], (create, rowIndex) => [`${t.name}: create row ${rowIndex + 1}`, async t => {
await assert.rejects(create(), error => !String(error).includes(botToken) && !String(error).includes(webhookUrl));
}]));
  const protocol = createSlackBotProtocol({ resolveDestination: async () => ({ token: botToken, channel, endpoint: 'https://evil.example' }) });
  const wire = await protocol.prepare(bot(), 0); assert.equal(wire.url, 'https://slack.com/api/chat.postMessage');
  const rotated = createSlackBotProtocol({ resolveDestination: async () => ({ token: `xoxe.${botToken}`, channel }) });
  assert.equal((await rotated.prepare(bot(), 0)).headers.authorization, `Bearer xoxe.${botToken}`);
  await runCases(t, [
    ["bot refusal inputs: case 1", async t => {
      await assert.rejects(protocol.prepare({ ...bot(), body: serializeSlackMessage(message, 'CEVIL') }, 0), /options/);
    }],
    ["bot refusal inputs: case 2", async t => {
      await assert.rejects(protocol.prepare({ ...bot(), body: JSON.stringify({ ...JSON.parse(bot().body), token: botToken }) }, 0), /Unsupported/);
    }],
    ["bot refusal inputs: case 3", async t => {
      await assert.rejects(createSlackBotProtocol({ resolveDestination: async () => ({ token: botToken + '\r\nX-Injected: yes', channel }) }).prepare(bot(), 0), /configuration/);
    }]
  ]);
}]);
foldedCases.push(['destination drift and channel drift reject preflight before real transport', async t => {
  const fixture = await wireFixture(t), db = durableFixture(t); let url = webhookUrl, configuredChannel = channel;
  const notifier = createSlackNotifier({ repository: db.repository(), transport: fixture.transport, templates: slackEventTemplates,
    incomingWebhook: async () => url, bot: async () => ({ token: botToken, channel: configuredChannel }) });
  for (const mode of ['incoming-webhook', 'bot'] as const) await notifier.enqueue({ ...base, id: mode, mode, data: { title: 'Local', detail: 'Update' } });
  url = webhookUrl.replace('localFixtureOnly', 'changedFixtureOnly'); configuredChannel = 'CCHANGED';
  await runCases(t, Array.from(['incoming-webhook', 'bot'], (id, rowIndex) => [`${t.name}: id row ${rowIndex + 1}`, async t => {
    assert.equal((await notifier.delivery.dispatch(id))?.state, 'rejected');
    assert.equal((await notifier.delivery.log(id))[0]!.outcome?.code, 'preflight_failed');
}]));
  assert.equal(fixture.received.length, 0);
}]);
foldedCases.push(['real response errors and redirect do not leak secrets or forward bearer headers', async t => {
  const fixture = await wireFixture(t), db = durableFixture(t);
  const notifier = createSlackNotifier({ repository: db.repository(), transport: fixture.transport, templates: slackEventTemplates, bot: async () => ({ token: botToken, channel }) });
  const responses = [
    { status: 200, body: JSON.stringify({ ok: false, error: 'invalid_auth', detail: botToken }) },
    { status: 200, body: JSON.stringify({ ok: false, error: botToken }) },
    { status: 302, body: '', headers: { location: 'https://evil.example/capture' } },
  ];
  await runCases(t, Array.from(responses.entries(), ([index, response], rowIndex) => [`${t.name}: [index, response] row ${rowIndex + 1}`, async t => {
    const id = `response-${index}`; await notifier.enqueue({ ...base, id, mode: 'bot', data: { title: 'Local', detail: 'Update' } });
    fixture.replies.push(response); await notifier.delivery.dispatch(id);
    assert.equal((await notifier.delivery.get(id))?.state, index === 0 ? 'rejected' : 'uncertain');
    assert.equal(JSON.stringify(await notifier.delivery.log(id)).includes(botToken), false);
}]));
  await notifier.delivery.dispatchDue(); assert.equal(fixture.received.length, 3);
  assert.equal(db.bytes().includes(botToken), false);
}]);
foldedCases.push(['production core transport rejects private literal endpoints without connecting', async (t) => {
  const transport = new NodePinnedTransport();
  await runCases(t, Array.from(['https://127.0.0.1/secret', 'https://169.254.169.254/secret', 'https://[::1]/secret', 'http://slack.com/api/chat.postMessage'], (url, rowIndex) => [`${t.name}: url row ${rowIndex + 1}`, async t => {
await assert.rejects(transport.send({ url, headers: {}, body: 'local' }));
}]));
}]);
  await runCases(t, foldedCases);
});
