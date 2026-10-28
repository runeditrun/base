import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapturedMail } from './agent-mail.mjs';
import { createFixtureControl } from './agent-fixtures.mjs';

const message = (to, text, origin = 'https://api.resend.com/emails') => new Request(origin, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-not-a-credential' }, body: JSON.stringify({ to, subject: 'Confirmation', text }) });

test('captured mail is scoped to one mailbox, bounded in count, size and age, and cleared on close', async () => {
 let now = 1000;
 const mail = createCapturedMail('synthetic-owner@example.com', () => now);
 await mail.capture(message('other@example.com', 'not visible'));
 await mail.capture(message('synthetic-owner@example.com', 'undeclared', 'https://mail.example.invalid/send'));
 assert.deepEqual(mail.read(), []);
 for (let i = 0; i < 25; i++) await mail.capture(message('synthetic-owner@example.com', `confirmation-${i}`));
 const captured = mail.read({ limit: 20 });
 assert.equal(captured.length, 20);
 assert.equal(captured[0].text, 'confirmation-5');
 assert.equal(captured[19].text, 'confirmation-24');
 assert.deepEqual(Object.keys(captured[0]).sort(), ['at', 'html', 'id', 'subject', 'text']);
 captured[0].text = 'changed';
 assert.equal(mail.read({ limit: 20 })[0].text, 'confirmation-5');
 await mail.capture(message('synthetic-owner@example.com', 'x'.repeat(65_536)));
 assert.equal(mail.read({ limit: 20 }).length, 20);
 assert.throws(() => mail.read({ limit: 21 }));
 assert.throws(() => mail.read({ maxAgeMs: 300001 }));
 now += 300001;
 assert.deepEqual(mail.read(), []);
 mail.close();
 assert.throws(() => mail.read());
});

test('network fixture control accepts bounded JSON only for declared origins and one active run', () => {
 const fixtures = createFixtureControl(new Set(['https://dns.example.invalid']));
 fixtures.set('https://dns.example.invalid', { txt: 'native-per-run-value' });
 const value = fixtures.get('https://dns.example.invalid');
 value.txt = 'changed';
 assert.equal(fixtures.get('https://dns.example.invalid').txt, 'native-per-run-value');
 assert.throws(() => fixtures.set('https://undeclared.example.invalid', {}));
 assert.throws(() => fixtures.set('https://dns.example.invalid', 'x'.repeat(16385)));
 for (let i = 1; i < 100; i++) fixtures.set('https://dns.example.invalid', { i });
 assert.throws(() => fixtures.set('https://dns.example.invalid', {}));
 fixtures.close();
 assert.equal(fixtures.get('https://dns.example.invalid'), undefined);
 assert.throws(() => fixtures.set('https://dns.example.invalid', {}));
});
