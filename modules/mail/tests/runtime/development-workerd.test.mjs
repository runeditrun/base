import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1DevelopmentOutbox } from '../../src/development/index.mjs';
import { createDevelopmentRuntime, developmentRequest } from './development-runtime.mjs';

const message = id => ({ deliveryId: id, from: 'sender@example.test', to: ['Reader <reader@example.test>'], subject: 'Sign in <b>safely</b>', text: 'Open https://example.test/sign-in?token=test&next=%22%3E', html: '<script>alert(1)</script>', attachments: [{ filename: 'raw.bin', contentType: 'application/octet-stream', content: Uint8Array.of(0, 255, 128, 10) }] });

test('historical D1 messages survive a restart while development sends leave no new records', { timeout: 60000 }, async () => {
  const path = await mkdtemp(join(tmpdir(), 'mail-development-'));
  let runtime;
  const fetch = (path = '/__dev/outbox', options = {}) => developmentRequest(runtime, path, options);
  try {
    runtime = await createDevelopmentRuntime(path);
    let db = await runtime.getD1Database('DB');
    const schema = await readFile(new URL('../../src/development/schema.sql', import.meta.url), 'utf8');
    const install = () => db.batch(schema.split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    await install(); await install();
    const input = message('runtime');
    const submitted = await fetch('/send', { method: 'POST', body: JSON.stringify({ deliveryId: 'suppressed', from: 'sender@example.test', to: ['reader@example.test'], subject: 'Hello', text: 'Body' }) });
    assert.deepEqual(await submitted.json(), { provider: 'development', status: 'development', providerMessageId: null });
    let outbox = createD1DevelopmentOutbox({ db });
    assert.deepEqual(await outbox.list(), []);
    // Older installations may retain mail; read and erasure support stays available.
    await outbox.put(input);
    const [summary] = await outbox.list();
    const capture = await outbox.get(summary.id);
    assert.deepEqual(capture.message, input);

    await runtime.dispose(); runtime = await createDevelopmentRuntime(path);
    db = await runtime.getD1Database('DB'); outbox = createD1DevelopmentOutbox({ db });
    assert.deepEqual(await outbox.get(capture.id), capture);

    {
      await db.prepare('DELETE FROM rer_mail_development_outbox').run();
      let time = 1000;
      const bounded = createD1DevelopmentOutbox({ db, maxMessages: 2, maxAgeMs: 100, clock: () => time });
      for (const id of ['first', 'second', 'third']) await bounded.put(message(id));
      const rows = await bounded.list(); assert.deepEqual(rows.map(row => row.message.deliveryId), ['third', 'second']);
      const one = createD1DevelopmentOutbox({ db, maxMessages: 1, maxAgeMs: 100, clock: () => time });
      // Reads bound the listing but never prune: the older row stays until a write.
      assert.equal((await one.get(rows[1].id)).message.deliveryId, 'second'); assert.equal((await one.list()).length, 1);
      await db.prepare("CREATE TRIGGER fail_outbox_cleanup BEFORE DELETE ON rer_mail_development_outbox BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END").run();
      await assert.rejects(one.put(message('rollback')), /cleanup failed/);
      assert.equal((await one.list())[0].message.deliveryId, 'third');
      await db.prepare('DROP TRIGGER fail_outbox_cleanup').run();
      time = 1100; assert.equal(await bounded.get(rows[0].id), null);
      assert.equal((await db.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').first()).count, 2);
      await bounded.put(message('expires'));
      assert.equal((await db.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').first()).count, 1); time = 1200;
      assert.deepEqual(await bounded.list(), []);
      await bounded.put(message('before-write')); time = 1300; await bounded.put(message('after-write'));
      assert.deepEqual((await bounded.list()).map(row => row.message.deliveryId), ['after-write']);
    }


  } finally { if (runtime) await runtime.dispose(); await rm(path, { recursive: true, force: true }); }
});
