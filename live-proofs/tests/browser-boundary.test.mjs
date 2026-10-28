import { startupRows } from './browser-startup.mjs'
import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserJourney } from '../../scripts/qualification/browser.mjs';
import { claimAndReply, sendAndReadMail } from '../../scripts/qualification/happytohelp.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';

const replayRows = []
const transcriptRows = []

// Protocol fixtures only. The production journey still drives actual Chromium.
function browserFixture(t, fault) {
  let now = 0; t.mock.method(Date, 'now', () => now += 31001);
  t.mock.method(globalThis, 'fetch', async () => new Response('widget-fixture'));
  const trace = [], pending = new Map(), origin = 'https://qualification.example';
  let frame, reply, request, pages = 0, closed = false, widgetReload = false, operatorReload = false;
  const response = data => ({ status: () => data.id === 'media' ? 201 : 200, json: async () => data });
  const publish = replay => {
    if (fault === (replay ? 'missing-replay' : 'missing-initial')) return;
    const content = fault === (replay ? 'wrong-replay-content' : 'wrong-initial-content') ? 'corrupted' : reply;
    const eventId = replay && fault === 'wrong-replay-event' ? 99 : 7;
    const emit = (content, eventId) => frame({ payload: JSON.stringify({ eventId, message: { id: 'reply', content } }) });
    if (!replay && fault === 'earlier-corrupt-event') emit('corrupted', 6);
    emit(content, eventId); trace.push(replay ? 'replay-frame' : 'initial-frame');
  };
  function page(role) {
    const locate = selector => ({
      getByText: locate,
      async fill(value) { if (selector === 'textarea[name=content]') request = value; if (selector === 'Type your reply…') reply = value; },
      async waitFor() {
        if (selector === reply && ((role === 'widget' && widgetReload && fault === 'widget-reload-missing') ||
          (role === 'operator' && operatorReload && fault === 'operator-reload-missing'))) throw new Error('reload-content-missing');
        trace.push(role + ':visible:' + selector);
      },
      async setInputFiles(file) { assert.equal(file.mimeType, 'text/plain'); trace.push('attachment'); },
      async boundingBox() { return { width: 390 }; },
      async click() {
        if (role === 'widget') {
          assert.equal(selector, 'button[name=submit]'); assert(request);
          pending.get('media')(response({ id: 'media' })); pending.get('visitor')(response({ accepted: true, message: { id: 'request' } }));
        } else if (selector === 'Send') {
          publish(false); pending.get('operator')(response({ accepted: true, message: { id: 'reply', actor_role: 'owner' } }));
        }
      },
    });
    return {
      on(name, callback) { if (name === 'websocket') callback({ url: () => origin + '/api/conversations/conversation/socket', on(name, callback) { frame = callback; } }); },
      async goto() {}, async waitForURL() {}, getByLabel: locate, getByPlaceholder: locate, locator: locate, getByText: locate,
      getByRole(kind, { name }) { return locate(name); },
      waitForResponse(predicate) {
        const kind = role === 'operator' ? 'operator' : predicate({ url: () => origin + '/api/conversations/conversation/media', request: () => ({ method: () => 'POST' }) }) ? 'media' : 'visitor';
        return new Promise(resolve => pending.set(kind, resolve));
      },
      async evaluate() { return { conversationId: 'conversation', contactId: 'visitor', projectId: 'project' }; },
      async reload() { trace.push(role + ':reload'); if (role === 'widget') { widgetReload = true; publish(true); } else operatorReload = true; },
      async setViewportSize(size) { assert.equal(size.width, 390); },
    };
  }
  const chromium = { launch: async () => ({ newPage: async () => page(pages++ ? 'widget' : 'operator'), close: async () => { closed = true; } }) };
  return { run: () => browserJourney({ origin, owner: { projectId: 'project' }, email: 'test@example.test', password: 'test-password', widgetKey: 'widget' }, chromium),
    trace, closed: () => closed };
}
for (const fault of [undefined, 'earlier-corrupt-event', 'missing-initial', 'wrong-initial-content', 'missing-replay',
  'wrong-replay-content', 'wrong-replay-event', 'widget-reload-missing', 'operator-reload-missing']) {
  replayRows.push(['browser replay boundary: ' + (fault ?? 'valid delivery'), {}, async t => {
    const fixture = browserFixture(t, fault);
    if (!fault || fault === 'earlier-corrupt-event') {
      const result = await fixture.run(); assert.equal(result.reply.socketEventId, '7'); assert(result.reply.replayVerified);
      const replay = fixture.trace.indexOf('replay-frame');
      assert(fixture.trace.slice(replay + 1).some(value => value.startsWith('widget:visible:Qualification reply ')), 'widget UI must be checked after replay');
      assert(fixture.trace.includes('attachment') && fixture.trace.includes('operator:reload'));
    } else await assert.rejects(fixture.run(), /socket-event-missing|reload-content-missing/);
    assert(fixture.closed(), 'browser closed on success and failure');
  }]);
}
function durableFixture(t, fault) {
  let claimed = false;
  const journey = { conversationId: 'conversation', requestContent: 'visitor request', replyContent: 'owner reply',
    reply: { visitorMessageId: 'request', operatorMessageId: 'reply' }, widget: {}, media: { mediaId: 'media', sha256: digest('attachment') } };
  const messages = [
    { id: 'request', actor_role: 'contact', conversation_id: 'conversation', content: 'visitor request' },
    { id: 'reply', actor_role: 'owner', conversation_id: 'conversation', content: 'owner reply' },
  ];
  if (fault === 'missing') messages.pop();
  if (fault === 'content') messages[1].content = 'wrong';
  if (fault === 'identity') messages[1].id = 'other-message';
  if (fault === 'actor') messages[1].actor_role = 'contact';
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/setup')) return Response.json({ available: !claimed, tokenRequired: true });
    if (url.endsWith('/bootstrap')) { claimed = true; return Response.json({ projectId: 'project', userId: 'owner', token: 'fixture-session' }, { status: 201 }); }
    if (url.endsWith('/session')) return Response.json({ id: 'owner', projectId: 'project', role: 'owner' });
    if (url.endsWith('/projects/project')) return Response.json({ widget_key: 'widget' });
    if (url.endsWith('/messages')) return Response.json({ messages });
    if (url.endsWith('/media/media')) return new Response('attachment');
    assert.fail('Unexpected API request');
  });
  const observations = [];
  return { observations, run: () => claimAndReply({ origin: 'https://qualification.example', env: {}, browser: async () => journey,
    observe: phase => observations.push(phase) }) };
}
for (const fault of [undefined, 'missing', 'content', 'identity', 'actor']) transcriptRows.push(['durable transcript boundary: ' + (fault ?? 'persisted'), {}, async t => {
  const fixture = durableFixture(t, fault);
  if (fault) { await assert.rejects(fixture.run(), /reply-readback-failed/); assert.deepEqual(fixture.observations, []); }
  else { await fixture.run(); assert.deepEqual(fixture.observations, ['owner', 'widget', 'reply', 'media']); }
}]);
test('accepted provider send still fails when its durable mail row is missing', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => url.includes('gmail.googleapis.com') ?
    Response.json(url.endsWith('/profile') ? { emailAddress: 'test@example.test' } : {}) :
    Response.json(url.endsWith('/test') ? { state: 'sent', id: 'provider-message' } : options.method === 'PUT' ? {} : { configured: true }));
  await assert.rejects(sendAndReadMail({ origin: 'https://qualification.example', env: {
    T016_MAILBOX_ADAPTER: 'gmail', T016_GMAIL_ACCESS_TOKEN: 'test-only', T016_TEST_MAILBOX: 'test@example.test', T016_SENDGRID_FROM: 'sender@example.test' },
    state: { owner: { projectId: 'project', token: 'test-only' } }, deliveryReadback: async () => ({}),
    observe() { assert.fail('No successful mail observation without durable provider association'); } }), /sendgrid-durable-readback-failed/);
});

test("reply delivery requires exact socket replay, visible reloads and a durable transcript", async t => {
  await runRows(t, [...replayRows, ...transcriptRows, ...startupRows])
})
