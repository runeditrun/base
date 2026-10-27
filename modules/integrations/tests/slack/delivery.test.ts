import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackNotifier, slackEventTemplates } from '../../slack/index.ts';
import { botToken, channel, durableFixture, successBot, webhookUrl, wireFixture } from './fixture.ts';

const notice = { id: 'event-1', tenant: 'installation', destinationId: 'slack-channel-v1', event: 'incident.opened', data: { title: 'Local check', detail: 'Investigating.' } };
const config = { incomingWebhook: async () => webhookUrl, bot: async () => ({ token: botToken, channel }), templates: slackEventTemplates };

test("Slack notification delivery preserves safe payloads and durable conservative retry outcomes", async t => {
  const foldedCases: Case[] = [];
await runCases(t, Array.from(['incoming-webhook', 'bot'] as const, (mode, rowIndex) => [`${t.name}: mode row ${rowIndex + 1}`, async t => {
  foldedCases.push([`${mode}: durable enqueue, real ${mode === 'bot' ? 'verified TLS' : 'HTTP'} POST, restart and deduplication`, async t => {
    const fixture = await wireFixture(t), db = durableFixture(t);
    let notifier = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport });
    const queued = await notifier.enqueue({ ...notice, mode });
    assert.equal(queued.state, 'queued'); assert.equal(fixture.received.length, 0);
    db.restart(); notifier = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport });
    fixture.replies.push({ status: 200, body: mode === 'bot' ? successBot : 'ok' });
    const results = await Promise.all([notifier.delivery.dispatch(notice.id), notifier.delivery.dispatch(notice.id)]);
    assert.equal(results.some(r => r?.state === 'accepted'), true);
    assert.equal(fixture.received.length, 1);
    const received = fixture.received[0]!;
    assert.equal(received.method, 'POST'); assert.equal(received.body, queued.body);
    assert.match(received.headers['content-type']!, /application\/json/);
    assert.equal(received.url, mode === 'bot' ? '/api/chat.postMessage' : '/services/TLOCAL/BLOCAL/localFixtureOnly');
    assert.equal(received.headers.authorization, mode === 'bot' ? `Bearer ${botToken}` : undefined);
    assert.equal(JSON.parse(received.body).channel, mode === 'bot' ? channel : undefined);
    const duplicate = await notifier.enqueue({ ...notice, mode }); assert.equal(duplicate.state, 'accepted');
    await notifier.delivery.dispatchDue(); assert.equal(fixture.received.length, 1);
    await assert.rejects(notifier.enqueue({ ...notice, mode, data: { ...notice.data, detail: 'Changed' } }), /conflict|reuse|immutable/i);
    const log = await notifier.delivery.log(notice.id); assert.equal(log.length, 1);
    assert.equal(log[0]!.outcome?.kind, 'accepted');
    let secretRow = 0;
    for (const secret of [botToken, webhookUrl, 'localFixtureOnly']) {
      await runCases(t, [[`${t.name} > secret row ${++secretRow}`, async () => {
        assert.equal(db.bytes().includes(secret), false); assert.equal(JSON.stringify(log).includes(secret), false);
      }]]);
    }
  }]);
  foldedCases.push([`${mode}: hostile user content reaches the provider only as escaped text`, async t => {
    const fixture = await wireFixture(t), db = durableFixture(t);
    const notifier = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport });
    const hostile = '<!channel> <!here> <!everyone> <@U123> <#C123> <!subteam^S123> <https://evil.example|click> &lt;!channel&gt;';
    const queued = await notifier.enqueue({ ...notice, id: 'hostile', mode, data: { title: hostile, detail: hostile } });
    fixture.replies.push({ status: 200, body: mode === 'bot' ? successBot : 'ok' });
    await notifier.delivery.dispatch('hostile');
    const body = fixture.received[0]!.body;
    assert.equal(body, queued.body); assert.doesNotMatch(body, /[<>]/);
    const sent = JSON.parse(body);
    assert.equal(sent.blocks[1].text.text, '&lt;!channel&gt; &lt;!here&gt; &lt;!everyone&gt; &lt;@U123&gt; &lt;#C123&gt; &lt;!subteam^S123&gt; &lt;https://evil.example|click&gt; &amp;lt;!channel&amp;gt;');
  }]);
  foldedCases.push([`${mode}: rate-limit cooldown survives restart; attempts and retry-after are bounded`, async t => {
    const fixture = await wireFixture(t), db = durableFixture(t); let now = 1000;
    const make = () => createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport, now: () => now });
    let notifier = make(); await notifier.enqueue({ ...notice, mode }, { maxAttempts: 2, retryDelaysMs: [100] });
    fixture.replies.push({ status: 429, body: 'rate_limited', headers: { 'Retry-After': '3' } });
    assert.equal((await notifier.delivery.dispatch(notice.id))?.nextAt, 4000);
    db.restart(); notifier = make(); now = 3999;
    assert.deepEqual(await notifier.delivery.dispatchDue(), []); assert.equal(fixture.received.length, 1);
    now = 4000; fixture.replies.push({ status: 429, body: 'rate_limited', headers: { 'Retry-After': '3' } });
    assert.equal((await notifier.delivery.dispatch(notice.id))?.state, 'rejected');
    now = 100000; await notifier.delivery.dispatchDue(); assert.equal(fixture.received.length, 2);
    assert.equal((await notifier.delivery.log(notice.id)).length, 2);
    await notifier.enqueue({ ...notice, id: 'excessive-delay', mode });
    fixture.replies.push({ status: 429, body: '', headers: { 'Retry-After': '86401' } });
    assert.equal((await notifier.delivery.dispatch('excessive-delay'))?.state, 'rejected');
    assert.equal((await notifier.delivery.log('excessive-delay'))[0]!.outcome?.code, 'retry_delay_exceeded');
  }]);
  foldedCases.push([`${mode}: response lost after receipt remains uncertain across restart, never replayed`, async t => {
    const fixture = await wireFixture(t), db = durableFixture(t); let now = 1000;
    const make = () => createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport, now: () => now });
    let notifier = make(); await notifier.enqueue({ ...notice, mode }); fixture.replies.push('disconnect');
    assert.equal((await notifier.delivery.dispatch(notice.id))?.state, 'uncertain'); assert.equal(fixture.received.length, 1);
    db.restart(); notifier = make(); now += 86400000;
    await notifier.delivery.dispatchDue(); await notifier.delivery.dispatch(notice.id);
    assert.equal(fixture.received.length, 1); assert.equal((await notifier.delivery.log(notice.id))[0]!.outcome?.code, 'response_unknown');
    await notifier.delivery.resolveUncertain(notice.id, 'accepted', 'operator_confirmed');
    assert.equal((await notifier.delivery.get(notice.id))?.state, 'accepted');
  }]);
}]));
foldedCases.push(['both paths persist explicit rejection and uncertain server errors from real receivers', async t => {
  const fixture = await wireFixture(t), db = durableFixture(t);
  const notifier = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport });
  await runCases(t, Array.from(['incoming-webhook', 'bot'] as const, (mode, rowIndex) => [`${t.name}: mode row ${rowIndex + 1}`, async t => {
    await runCases(t, Array.from(['rejected', 'uncertain'] as const, (state, rowIndex) => [`${t.name}: state row ${rowIndex + 1}`, async t => {
      const id = `${mode}-${state}`;
      await notifier.enqueue({ ...notice, id, mode });
      fixture.replies.push(state === 'uncertain' ? { status: 500, body: 'provider unknown' }
        : mode === 'bot' ? { status: 200, body: '{"ok":false,"error":"channel_not_found"}' }
        : { status: 400, body: 'invalid_payload' });
      assert.equal((await notifier.delivery.dispatch(id))?.state, state);
      assert.equal((await notifier.delivery.log(id))[0]!.outcome?.kind, state);
}]));
}]));
  await notifier.delivery.dispatchDue(); assert.equal(fixture.received.length, 4);
}]);
foldedCases.push(['actual SQLite failure propagates before sending; expired durable claim never replays', async t => {
  const fixture = await wireFixture(t), db = durableFixture(t); let now = 1000;
  const notifier = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport, now: () => now });
  await notifier.enqueue({ ...notice, mode: 'bot' });
  await db.repository().claim(notice.id, now, 60000);
  db.restart(); now += 61000;
  const restarted = createSlackNotifier({ ...config, repository: db.repository(), transport: fixture.transport, now: () => now });
  await restarted.delivery.dispatchDue(); assert.equal((await restarted.delivery.get(notice.id))?.state, 'uncertain');
  assert.equal(fixture.received.length, 0);
  db.execute('DROP TABLE integration_deliveries');
  await assert.rejects(restarted.enqueue({ ...notice, id: 'store-failed', mode: 'bot' }), /no such table/);
  assert.equal(fixture.received.length, 0);
}]);
  await runCases(t, foldedCases);
});
