import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

const invalid = () => new RerError('agent_reviewer_invalid', 'verification.reviewers must name at most eight unique {label,email,initializer} native reviewer lifecycles.', 1);
const failed = () => new RerError('agent_reviewer_failed', 'The native reviewer lifecycle did not return its confirmed session through the disposable installation.', 1);
const canonicalEmail = value => typeof value === 'string' && value === value.trim().toLowerCase() && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const mailboxAge = 300_000, maxBytes = 65_536, maxMessages = 20;
const mailProvider = request => {
 const url = new URL(request.url);
 return request.method !== 'POST' ? null : url.origin === 'https://api.resend.com' && url.pathname === '/emails' ? 'resend'
  : url.origin === 'https://api.sendgrid.com' && url.pathname === '/v3/mail/send' ? 'sendgrid'
  : url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/.test(url.pathname) ? 'cloudflare' : null;
};

/** Test tooling only: observe accepted paid mail edges for explicitly declared
 * reviewers. Native invitation, proof consumption and authority stay in the app. */
export async function verificationReviewers(root, declaration, ownerEmail) {
 const entries = new Map(), messages = [], completed = new Set(), attempted = new Set();
 let closed = false;
 if (declaration !== undefined) {
  if (!Array.isArray(declaration) || !declaration.length || declaration.length > 8) throw invalid();
  for (const value of declaration) {
   if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['label', 'email', 'initializer'].includes(key))
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.label) || !canonicalEmail(value.email) || value.email === ownerEmail
    || entries.has(value.label) || [...entries.values()].some(entry => entry.email === value.email) || typeof value.initializer !== 'string') throw invalid();
   await contained(root, value.initializer);
   let initialize;
   try { initialize = (await import(pathToFileURL(resolve(root, value.initializer)))).default; }
   catch { throw invalid(); }
   if (typeof initialize !== 'function') throw invalid();
   entries.set(value.label, { ...value, initialize });
  }
 }
 function prune() {
  const cutoff = Date.now() - mailboxAge;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].at < cutoff) messages.splice(i, 1);
 }
 function read(email, options = {}) {
  if (closed || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'maxAgeMs', 'after'].includes(key))) throw failed();
  const { limit = 10, maxAgeMs = mailboxAge, after = 0 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxMessages || !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > mailboxAge || !Number.isFinite(after) || after < 0) throw failed();
  prune();
  return messages.filter(message => message.to.includes(email) && message.at >= Math.max(after, Date.now() - maxAgeMs))
   .slice(-limit).map(({ to: _to, ...message }) => ({ ...message }));
 }
 return {
  observes: request => !closed && entries.size > 0 && mailProvider(request) !== null,
  // Read only clones, and never expose headers, provider credentials or another
  // mailbox. A rejected submission cannot become a delivered invitation.
  async capture(request, response) {
   if (closed || !entries.size || request.method !== 'POST' || !response.ok) return;
   const provider = mailProvider(request);
   if (!provider || Number(request.headers.get('content-length')) > maxBytes) return;
   const reader = request.body?.getReader();
   if (!reader) return;
   const chunks = []; let bytes = 0;
   try {
    for (;;) {
     const { done, value } = await reader.read();
     if (done) break;
     bytes += value.byteLength;
     if (bytes > maxBytes) { void reader.cancel().catch(() => {}); return; }
     chunks.push(value);
    }
   } finally { reader.releaseLock(); }
   let body, acknowledgement;
   try {
    body = JSON.parse(await new Blob(chunks).text());
    if (provider !== 'sendgrid') acknowledgement = await response.json();
   } catch { return; }
   if (closed) return;
   if (provider === 'resend' && typeof acknowledgement?.id !== 'string'
    || provider === 'sendgrid' && response.status !== 202
    || provider === 'cloudflare' && acknowledgement?.success !== true) return;
   const array = value => Array.isArray(value) ? value : value ? [value] : [];
   const recipients = provider === 'sendgrid' ? array(body?.personalizations).flatMap(item => array(item?.to).map(to => to?.email)) : array(body?.to);
   const to = [...entries.values()].map(entry => entry.email).filter(email => recipients.includes(email)
    && (provider !== 'cloudflare' || array(acknowledgement.result?.accepted).includes(email)));
   if (!to.length) return;
   const content = provider === 'sendgrid' ? array(body?.content) : [];
   const text = provider === 'sendgrid' ? content.find(item => item?.type === 'text/plain')?.value : body?.text;
   const html = provider === 'sendgrid' ? content.find(item => item?.type === 'text/html')?.value : body?.html;
   prune();
   messages.push({ id: randomUUID(), at: Date.now(), to, subject: typeof body?.subject === 'string' ? body.subject : '',
    text: typeof text === 'string' ? text : '', html: typeof html === 'string' ? html : '' });
   if (messages.length > maxMessages) messages.shift();
  },
  async initialize(label, owner, { request, origin, returnTo = '/' }) {
   if (closed || !entries.has(label) || attempted.has(label) || !owner || typeof owner.cookie !== 'string' || !owner.cookie || owner.cookie.length > 16_384) throw failed();
   attempted.add(label);
   const entry = entries.get(label);
   try {
    const response = await entry.initialize({ request, origin, label, email: entry.email, owner: { email: ownerEmail, cookie: owner.cookie },
     returnTo, mail: Object.freeze({ read: options => read(entry.email, options) }) });
    if (closed || !(response instanceof Response) || ![200, 303].includes(response.status) || response.redirected) throw failed();
    const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    await response.body?.cancel();
    if (!cookie || cookie === owner.cookie) throw failed();
    completed.add(label);
    return { email: entry.email, cookie };
   } catch { throw failed(); }
  },
  points: () => [...entries.keys()].map(label => ({ id: `BASE-AGENT-001.reviewer.${label}.native-session`, ok: completed.has(label),
   ...(!completed.has(label) ? { detail: 'Declared native reviewer lifecycle did not complete.' } : {}) })),
  close() { closed = true; messages.length = 0; },
 };
}
