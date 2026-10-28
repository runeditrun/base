import { runCases } from '../../tests/cases.mjs';
// The shared sign-in page accepts `login_hint` to prefill the email field, so a
// claimed owner sent here by an Open app or Lobby link need not type it again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, presets } from '../../identity/oidc/tests/fake-runtime.mjs';

const field = html => html.match(/<input id="signin-email"[^>]*>/)?.[0] ?? '';

test('sign-in prefills the email field from login_hint and never submits it', async t => {
const page = async (t, hint) => {
const r = await runtime(t, presets());
    const response = await r.call(`/signin?returnTo=/app/queue${hint === undefined ? '' : `&login_hint=${encodeURIComponent(hint)}`}`);
    assert.equal(response.status, 200);
    return response.text();

};
  await runCases(t, [
['empty login hint', async t => {
  const empty = await page(t);
  assert.match(field(empty), /id="signin-email" name="email" type="email"/);
  assert.doesNotMatch(field(empty), /value=/);
}],
['prefilled login hint', async t => {

  const hinted = await page(t, 'Owner@Example.COM');
  assert.match(field(hinted), /value="owner@example\.com"/);
  assert.match(hinted, /<form method="post" action="\/auth\/magic-link">/, 'the visitor still submits the form themself');
  assert.doesNotMatch(hinted, /<script|autofocus|onload|http-equiv="refresh"/i);
}],
['invalid login hint variants', async t => {

  await runCases(t, Array.from(['not an email', 'a@b', '"><script>alert(1)</script>@x.example', 'x'.repeat(300) + '@example.com', ''], (bad, rowIndex) => [`${t.name}: bad row ${rowIndex + 1}`, async t => {
    const html = await page(t, bad);
    assert.doesNotMatch(field(html), /value=/, `ignored: ${bad.slice(0, 20)}`);
    assert.doesNotMatch(html, /<script/i);
}]));
}]
  ]);
});
