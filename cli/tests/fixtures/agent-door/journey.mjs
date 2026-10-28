import { confirmMail } from './confirm-mail.mjs';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const content = answer => answer.result?.structuredContent;
const refused = answer => answer.result?._meta?.['com.runeditrun/error']?.code;
export default async function journey({ request, origin, email, mail, fixtures, tool }) {
 // G5: the journey has the same private captured reader as the initializer.
 const confirmed = await confirmMail({ request, origin, email, mail });
 const cookie = confirmed.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
 await confirmed.body?.cancel();
 const account = await request(new URL('/app', origin).href, { headers: { Cookie: cookie } });
 require(account.ok && (await account.text()).includes(email), 'Confirmed native owner must read their account');
 const absent = await request(new URL('/agents/captured-mail', origin).href, { headers: { Cookie: cookie } });
 require(absent.status === 404, 'Captured mail must have no served route'); await absent.body?.cancel();
 // G6: each native record contains a fresh random challenge. Read its actual
 // saved value through a declared native tool, then control the isolated edge.
 for (let round = 0; round < 2; round++) {
  const created = content(await tool('fixture.records.create', { value: crypto.randomUUID(), idempotency_key: crypto.randomUUID() }));
  require(created?.id, 'Native challenge creation failed');
  const native = content(await tool('fixture.records.list', {})).records.find(record => record.id === created.id);
  require(native?.value, 'Native challenge accessor failed');
  fixtures.set('https://receiver.example.invalid', { value: round ? 'stale-previous-challenge' : 'unconfigured' });
  const before = content(await tool('fixture.records.list', {})).counts.receipts;
  const stale = await tool('fixture.records.deliver', { id: native.id, idempotency_key: crypto.randomUUID() });
  require(refused(stale) === 'delivery_failed', 'Stale fixture must fail native receipt validation');
  require(content(await tool('fixture.records.list', {})).counts.receipts === before, 'Refused fixture must have no receipt effect');
  fixtures.set('https://receiver.example.invalid', { value: native.value });
  const delivered = content(await tool('fixture.records.deliver', { id: native.id, idempotency_key: crypto.randomUUID() }));
  require(delivered?.body.signatureVerified === true, 'Per-run fixture must retain native signature validation');
  const denied = content(await tool('fixture.records.denied', { id: native.id, idempotency_key: crypto.randomUUID() }));
  require(denied?.status === 502, 'Undeclared hosts must remain refused');
 }
 fixtures.set('https://receiver.example.invalid', null);
}
