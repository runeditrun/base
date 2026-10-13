import { setTimeout as delay } from 'node:timers/promises';
import { abortable } from './cancellation.mjs';

export async function signInThroughOutbox(page, { origin, email, request, outboxPath = '/__dev/outbox', timeoutMs = 10_000, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Outbox timeoutMs must be positive');
  const listing = new URL(outboxPath, origin);
  if (listing.origin !== origin) throw new TypeError('Outbox must be same-origin');
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const ensureActive = () => { signal?.throwIfAborted(); if (finished || performance.now() >= deadline) throw new Error('outbox work timed out'); };
  let reader, closing, failure, step = 'requesting the sign-in message', timer, finished = false;
  async function closeReader() {
    if (!reader) return;
    if (!closing) closing = (async () => {
      let cleanupTimer;
      try {
        await Promise.race([
          Promise.resolve().then(() => reader.close()),
          new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('reader cleanup timed out')), 1000); }),
        ]);
      } finally { clearTimeout(cleanupTimer); }
    })();
    await closing;
  }
  const work = async () => {
    const startedAt = Date.now();
    await request(page, signal);
    ensureActive();
    step = 'opening the outbox reader';
    reader = await page.context().newPage();
    // A page created after cancellation or the deadline still belongs to this helper.
    if (finished || signal?.aborted || performance.now() >= deadline) { await closeReader(); throw new Error('reader creation cancelled or timed out'); }
    step = 'waiting for a new outbox message';
    let message;
    while (performance.now() < deadline) {
      ensureActive();
      await reader.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: remaining() });
      ensureActive();
      const rows = await reader.locator('article').evaluateAll(articles => articles.map(article => ({
        to: [...article.querySelectorAll('p')].find(p => p.textContent.startsWith('To: '))?.textContent.slice(4),
        received: Date.parse(article.querySelector('time')?.getAttribute('datetime') ?? ''),
        href: article.querySelector('a')?.getAttribute('href'),
      })));
      ensureActive();
      message = rows.filter(row => row.received >= startedAt && row.to?.split(',').some(recipient => (recipient.match(/<([^>]+)>/)?.[1] ?? recipient).trim().toLowerCase() === email.trim().toLowerCase()))
        .sort((a, b) => b.received - a.received)[0];
      if (message) break;
      await delay(Math.min(100, remaining()));
    }
    if (!message) throw new Error('no new message');
    step = 'opening the outbox message';
    const detail = new URL(message.href, origin);
    if (detail.origin !== origin) throw new Error('foreign message page');
    await reader.goto(detail.href, { waitUntil: 'domcontentloaded', timeout: remaining() });
    ensureActive();
    const href = await reader.getByRole('link', { name: 'Open this link', exact: true }).getAttribute('href', { timeout: remaining() });
    ensureActive();
    step = 'checking the sign-in link origin';
    const link = new URL(href, origin);
    if (link.origin !== origin || link.username || link.password) throw new Error('foreign sign-in link');
    step = 'navigating to the sign-in confirmation';
    await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: remaining() });
    ensureActive();
  };
  try {
    await abortable(() => Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('outbox work timed out')), remaining()); }),
    ]), signal);
  } catch {
    // Never retain Playwright's call log: it can contain the private link.
    failure = new Error(`Outbox sign-in failed while ${step} (bound ${timeoutMs}ms)`);
  } finally {
    finished = true;
    clearTimeout(timer);
    try { await closeReader(); }
    catch { failure = new Error(`Outbox reader cleanup failed${failure ? `; ${failure.message}` : ''}`); }
  }
  if (failure) throw failure;
}
