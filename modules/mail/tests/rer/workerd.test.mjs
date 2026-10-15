import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../runtime/harness.mjs';

const signIn = { deliveryId: 'sign-in-1', from: 'Support <support@example.test>', to: ['reader@example.test'], subject: 'Your sign-in link',
  text: 'Sign in: https://app.example.test/auth/confirm', headers: { 'Auto-Submitted': 'auto-generated' } };
const notice = { deliveryId: 'notice-1', from: 'News <news@example.test>', to: ['reader@example.test'], subject: 'A new post', text: 'A new post is up.',
  headers: { 'List-Unsubscribe': '<https://app.example.test/unsubscribe/abc>, <mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-Id': 'Subscriber notices <notices.example.test>', 'List-Archive': '<https://app.example.test/notices>', 'List-Help': '<mailto:help@example.test>',
    'In-Reply-To': '<post.42@example.test>', References: '<post.41@example.test> <post.42@example.test>' } };

test('a Worker sends sign-in and threaded subscriber notices through the rer relay and refuses invalid headers locally', async () => {
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
    for (const headers of [{ 'Auto-Submitted': 'auto-replied' }, { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<https://a.example.test/1>, <https://b.example.test/2>, <mailto:leave@example.test>' },
      { 'List-Unsubscribe': `<https://app.example.test/${'u'.repeat(2000)}>` }, { 'Message-ID': '<id@example.test>' }]) {
      const result = await send({ ...notice, headers });
      assert.ok(result.error, JSON.stringify(headers));
    }
    assert.equal(relay.length, 3);

    for (const [name, values, error] of [
      ['List-Id', ['<undotted>', 'News <a..example.test>', 'Café <news.example.test>', '"bad\tname" <news.example.test>',
        `<${'a'.repeat(252)}.test>`, `${'a'.repeat(2000)} <news.example.test>`, 'News\r\n<news.example.test>', null], 'invalid_list_id'],
      ['List-Archive', ['<http://app.example.test/archive>', '<https://>', '<https://app.example.test\\archive>',
        '<https://a.example.test>, <https://b.example.test>, <https://c.example.test>', `<https://app.example.test/${'a'.repeat(2000)}>`, 42], 'invalid_list_archive'],
      ['List-Help', ['<mailto:help@localhost>', 'NO', '<https://>', '<https://app.example.test/\u007fhelp>', false], 'invalid_list_help'],
      ['In-Reply-To', ['<a@example.test> <b@example.test>', '<"a"@example.test>', '<a..b@example.test>', '<a@[nested[domain]]>',
        ' <a@example.test>', '<a@example.test>\t', `<${'a'.repeat(2000)}@example.test>`, {}], 'invalid_in_reply_to'],
      ['References', ['', '<a@example.test>, <b@example.test>', '<a@example.test>\t<b@example.test>', ' <a@example.test>',
        '<a@example.test> ', Array(21).fill('<a@example.test>').join(' '), `<${'a'.repeat(2000)}@example.test>`, []], 'invalid_references'],
    ]) for (const value of values) {
      assert.deepEqual(await send({ ...notice, headers: { ...notice.headers, [name]: value } }), { error }, name);
      assert.equal(relay.length, 3, `${name} must fail before dispatch`);
    }

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
