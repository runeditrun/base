import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackNotifier, slackEventTemplates } from '../../index.ts';
import { store, loopback } from './support.ts';

const slackUrl = 'https://hooks.slack.com/services/TLOCAL/BLOCAL/fixture-secret';
test('public provider composition: both Slack paths and credential custody', async t => {
  const db = await store(t); const now = 1800000000000;
  let loseSlackReply = false;
  const wire = await loopback(t, [slackUrl, 'https://slack.com/api/chat.postMessage'], async (request, req, res) => {
    const body = JSON.parse(request.body);
    if (request.url === slackUrl) {
      assert.equal(request.headers.authorization, undefined); assert.equal(body.blocks[0].type, 'section'); assert.equal(body.channel, undefined);
      res.end('ok'); return;
    }
    if (request.url === 'https://slack.com/api/chat.postMessage') {
      assert.equal(request.headers.authorization, ['Bear', 'er x', 'oxb-', 'loca', 'l-fi', 'xtur', 'e'].join('')); assert.equal(body.channel, 'CLOCAL123');
      if (loseSlackReply) { req.socket.destroy(); return; }
      res.end(JSON.stringify({ ok: true, channel: 'CLOCAL123', ts: '1800000000.000001' })); return;
    }
    assert.fail('Unexpected provider URL');
  });
  const slack = () => createSlackNotifier({ repository: db.repo(), transport: wire.transport, templates: slackEventTemplates,
    incomingWebhook: async id => { assert.equal(id, 'slack-hook-v1'); return slackUrl; },
    bot: async id => { assert.equal(id, 'slack-bot-v1'); return { channel: 'CLOCAL123', token: ['xoxb', 'local', 'fixture'].join('-') }; }, now: () => now });
  for (const mode of ['incoming-webhook', 'bot'] as const) {
    const id = `slack-${mode}`;
    await slack().enqueue({ id, tenant: 'installation', destinationId: mode === 'bot' ? 'slack-bot-v1' : 'slack-hook-v1', event: 'incident.opened', mode, data: { title: 'Payments', detail: 'Investigating' } });
    assert.equal((await slack().delivery.dispatch(id))?.state, 'accepted');
  }
  loseSlackReply = true;
  await slack().enqueue({ id: 'slack-lost', tenant: 'installation', destinationId: 'slack-bot-v1', event: 'incident.opened', mode: 'bot', data: { title: 'Payments', detail: 'Investigating' } });
  assert.equal((await slack().delivery.dispatch('slack-lost'))?.state, 'uncertain');
  db.restart(); const count = wire.received.length;
  await slack().delivery.dispatchDue(); await slack().delivery.dispatch('slack-lost'); assert.equal(wire.received.length, count);
  const stored = await db.contents();
  for (const secret of [slackUrl, ['xoxb', 'local', 'fixture'].join('-')]) assert.equal(stored.includes(secret), false);
  assert.deepEqual(wire.failures, []);
});
