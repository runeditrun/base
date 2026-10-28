import { randomUUID } from 'node:crypto';

// rer-conformance-captured-mail/1: disposable verifier memory, never a route,
// database binding or application module. Capture no provider headers/secrets.
const maxCount = 20, maxAge = 300_000, maxBytes = 65_536;
const address = value => typeof value === 'string' ? value.toLowerCase().match(/(?:<)?([^\s<>]+@[^\s<>]+)>?$/)?.[1] : value?.email?.toLowerCase();
const list = value => Array.isArray(value) ? value : value ? [value] : [];

export function createCapturedMail(email, now = Date.now) {
 const messages = [];
 let closed = false;
 const prune = () => { while (messages.length && now() - messages[0].at > maxAge) messages.shift(); };
 return {
  read({ limit = 10, maxAgeMs = maxAge, after = 0 } = {}) {
   if (closed || !Number.isSafeInteger(limit) || limit < 1 || limit > maxCount || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > maxAge || !Number.isFinite(after)) throw new TypeError('Captured mail requires an active run, limit 1..20 and age 0..300000ms.');
   prune();
   return structuredClone(messages.filter(message => message.at >= after && now() - message.at <= maxAgeMs).slice(-limit));
  },
  async capture(request) {
   if (closed || request.method !== 'POST') return;
   const url = new URL(request.url);
   const sendgrid = url.origin === 'https://api.sendgrid.com' && url.pathname === '/v3/mail/send';
   const resend = url.origin === 'https://api.resend.com' && url.pathname === '/emails';
   const cloudflare = url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/.test(url.pathname);
   if (!sendgrid && !resend && !cloudflare) { void request.body?.cancel(); return; }
   // Bound both intake and retained data. Oversized or malformed submissions
   // remain the native provider adapter's responsibility and are not captured.
   const reader = request.body?.getReader();
   if (!reader) return;
   const chunks = []; let length = 0;
   try {
    for (;;) {
     const chunk = await reader.read();
     if (chunk.done) break;
     length += chunk.value.byteLength;
     if (length > maxBytes) { void reader.cancel(); return; }
     chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const recipients = sendgrid ? list(body.personalizations).flatMap(item => list(item.to)) : list(body.to);
    if (!recipients.some(value => address(value) === email)) return;
    const text = sendgrid ? list(body.content).filter(item => item.type === 'text/plain').map(item => item.value).join('\n') : body.text;
    const html = sendgrid ? list(body.content).filter(item => item.type === 'text/html').map(item => item.value).join('\n') : body.html;
    prune();
    messages.push({ id: randomUUID(), at: now(), subject: typeof body.subject === 'string' ? body.subject : '', text: typeof text === 'string' ? text : '', html: typeof html === 'string' ? html : '' });
    if (messages.length > maxCount) messages.shift();
   } catch { /* A refused capture never prints a mail body or confirmation. */ }
   finally { reader.releaseLock(); }
  },
  close() { closed = true; messages.length = 0; },
 };
}
