import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorker } from '../runtime/harness.mjs';

const signIn = { deliveryId: 'sign-in-1', from: 'Support <support@example.test>', to: ['reader@example.test'], subject: 'Your sign-in link',
  text: 'Sign in: https://app.example.test/auth/confirm', headers: { 'Auto-Submitted': 'auto-generated' } };
const notice = { deliveryId: 'notice-1', from: 'News <news@example.test>', to: ['reader@example.test'], subject: 'A new post', text: 'A new post is up.',
  headers: { 'List-Unsubscribe': '<https://app.example.test/unsubscribe/abc>, <mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-Id': 'Subscriber notices <notices.example.test>', 'List-Archive': '<https://app.example.test/notices>', 'List-Help': '<mailto:help@example.test>',
    'In-Reply-To': '<post.42@example.test>', References: '<post.41@example.test> <post.42@example.test>' } };

test('a Worker sends sign-in and threaded subscriber notices through the rer relay and refuses invalid headers locally', async (t) => {
  const relay = [];
  let status = 202;
  const worker = await createWorker('tests/rer/relay-worker.mjs', ['index.mjs'], async request => {
    relay.push({ url: request.url, body: await request.json() });
    return new Response(null, { status, headers: status === 302 ? { location: 'https://elsewhere.example.test/capture' } : {} });
  });
  const send = async message => (await worker.dispatchFetch('https://mail.test', { method: 'POST', body: JSON.stringify(message) })).json();
  try {
    assert.deepEqual(await send(signIn), { provider: 'rer', status: 'accepted', providerMessageId: null });
    assert.deepEqual(await send(notice), { provider: 'rer', status: 'accepted', providerMessageId: null });
    // The relay stamps Auto-Submitted itself; one-click unsubscribe travels as its two fields.
    assert.deepEqual(relay.map(request => request.body), [
      { to: 'reader@example.test', subject: signIn.subject, text: signIn.text },
      { to: 'reader@example.test', subject: notice.subject, text: notice.text,
        listUnsubscribe: '<https://app.example.test/unsubscribe/abc>, <mailto:leave@example.test>', listUnsubscribePost: true,
        listId: notice.headers['List-Id'], listArchive: notice.headers['List-Archive'], listHelp: notice.headers['List-Help'],
        inReplyTo: notice.headers['In-Reply-To'], references: notice.headers.References },
    ]);
    status = 302;
    assert.deepEqual(await send(signIn), { provider: 'rer', status: 'rejected', providerMessageId: null, code: 'provider_redirected' });
    assert.deepEqual(relay.map(request => new URL(request.url).host), Array(3).fill('managed.example.test'));
    // What the relay would refuse with a 400 is refused before any request.
    await runCases(t, Array.from([{ 'Auto-Submitted': 'auto-replied' }, { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<https://a.example.test/1>, <https://b.example.test/2>, <mailto:leave@example.test>' },
      { 'List-Unsubscribe': `<https://app.example.test/${'u'.repeat(2000)}>` }, { 'Message-ID': '<id@example.test>' }], (headers, rowIndex) => [`${t.name}: headers row ${rowIndex + 1}`, async t => {
      const result = await send({ ...notice, headers });
      assert.ok(result.error, JSON.stringify(headers));
}]));
    assert.equal(relay.length, 3);

    await runCases(t, Array.from([
      ['List-Id', ['<undotted>', 'News <a..example.test>', 'Café <news.example.test>', '"bad\tname" <news.example.test>',
        `<${'a'.repeat(252)}.test>`, `${'a'.repeat(2000)} <news.example.test>`, 'News\r\n<news.example.test>', null], 'invalid_list_id'],
      ['List-Archive', ['<http://app.example.test/archive>', '<https://>', '<https://app.example.test\\archive>',
        '<https://a.example.test>, <https://b.example.test>, <https://c.example.test>', `<https://app.example.test/${'a'.repeat(2000)}>`, 42], 'invalid_list_archive'],
      ['List-Help', ['<mailto:help@localhost>', 'NO', '<https://>', '<https://app.example.test/\u007fhelp>', false], 'invalid_list_help'],
      ['In-Reply-To', ['<a@example.test> <b@example.test>', '<"a"@example.test>', '<a..b@example.test>', '<a@[nested[domain]]>',
        ' <a@example.test>', '<a@example.test>\t', `<${'a'.repeat(2000)}@example.test>`, {}], 'invalid_in_reply_to'],
      ['References', ['', '<a@example.test>, <b@example.test>', '<a@example.test>\t<b@example.test>', ' <a@example.test>',
        '<a@example.test> ', Array(21).fill('<a@example.test>').join(' '), `<${'a'.repeat(2000)}@example.test>`, []], 'invalid_references'],
    ], ([name, values, error], rowIndex) => [`${t.name}: [name, values, error] row ${rowIndex + 1}`, async t => {
await runCases(t, Array.from(values, (value, rowIndex) => [`${t.name}: value row ${rowIndex + 1}`, async t => {
      assert.deepEqual(await send({ ...notice, headers: { ...notice.headers, [name]: value } }), { error }, name);
      assert.equal(relay.length, 3, `${name} must fail before dispatch`);
}]));
}]));

    status = 202;
    // Platform permits separator tabs, quoted ASCII phrases, mailto query strings,
    // dot-atoms without domain dots and bracketed domain literals. Preserve bytes.
    const headers = { 'lIsT-iD': '\t"Subscriber \\"notices\\""\t<news.example.test>\t',
      'list-archive': '\t<HTTPS://user:pass@app.example.test:8443/archive#posts>\t,\t<mailto:archive@example.test?subject=Archive>\t',
      'LIST-HELP': '<mailto:help@example.test?subject=Help>, <mailto:help@example.test?subject=Help>',
      'in-reply-to': '<post@[127.0.0.1]>', references: '<root@local>  <post@[]>' };
    assert.equal((await send({ ...notice, headers })).status, 'accepted');
    assert.deepEqual(relay.at(-1).body, { to: 'reader@example.test', subject: notice.subject, text: notice.text,
      listId: headers['lIsT-iD'], listArchive: headers['list-archive'], listHelp: headers['LIST-HELP'],
      inReplyTo: headers['in-reply-to'], references: headers.references });
    assert.equal(relay.length, 4);
  } finally { await worker.dispose(); }
});

// Platform c1e3ade's keyed Message-ID: RFC 4648 base32 of sha256(installation + ':' + key), first 32 characters.
function relayMessageId(messageKey) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let local = '', buffer = 0, bits = 0;
  for (const byte of createHash('sha256').update('installation-1:' + messageKey).digest().subarray(0, 20)) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; local += alphabet[(buffer >>> bits) & 31]; }
  }
  return `<${local}@mail.rer.example.test>`;
}

test('a Worker threads incident updates on the Message-ID the relay assigned to the first notice', async (t) => {
  const relay = [];
  const worker = await createWorker('tests/rer/relay-worker.mjs', ['index.mjs'], async request => {
    const body = await request.json();
    relay.push(body);
    return Response.json({ accepted: true, messageId: relayMessageId(body.messageKey) }, { status: 202 });
  });
  const send = async message => (await worker.dispatchFetch('https://mail.test', { method: 'POST', body: JSON.stringify(message) })).json();
  const incident = { deliveryId: 'incident-7-opened', from: 'Status <status@example.test>', to: ['oncall@example.test'],
    subject: 'Incident 7: elevated errors', text: 'We are investigating elevated errors.', messageKey: 'incident:7:opened' };
  try {
    const root = relayMessageId(incident.messageKey);
    assert.deepEqual(await send(incident), { provider: 'rer', status: 'accepted', providerMessageId: root });
    const update = { ...incident, deliveryId: 'incident-7-update-1', text: 'A fix is rolling out.', messageKey: 'incident:7:update-1',
      headers: { 'In-Reply-To': root, References: root } };
    assert.deepEqual(await send(update), { provider: 'rer', status: 'accepted', providerMessageId: relayMessageId(update.messageKey) });
    assert.deepEqual(relay, [
      { to: 'oncall@example.test', subject: incident.subject, text: incident.text, messageKey: incident.messageKey },
      { to: 'oncall@example.test', subject: incident.subject, text: update.text, messageKey: update.messageKey, inReplyTo: root, references: root },
    ]);
    // The relay's own messageKey rule, refused before any request; a raw Message-ID stays refused.
    await runCases(t, Array.from(['', 'k'.repeat(201), 'incident 7', 'incident/7', 'incident@7', 'Störung-7', 7, null], (messageKey, rowIndex) => [`${t.name}: messageKey row ${rowIndex + 1}`, async t => {
      assert.deepEqual(await send({ ...incident, messageKey }), { error: 'invalid_message_key' }, JSON.stringify(messageKey));
}]));
    assert.deepEqual(await send({ ...incident, headers: { 'Message-ID': root } }), { error: 'unsupported_provider_setting' });
    assert.equal((await send({ ...incident, messageKey: 'k'.repeat(200) })).status, 'accepted');
    assert.equal((await send({ ...incident, messageKey: 'A-z_0.9:-' })).status, 'accepted');
    assert.equal(relay.length, 4);
  } finally { await worker.dispose(); }
});
