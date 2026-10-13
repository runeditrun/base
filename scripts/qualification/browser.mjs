import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { digest, insist } from './operations.mjs';
import { hostedOrigin, request } from './http.mjs';

const widgetHost = 'http://127.0.0.1:4179';
export const widgetHostOrigin = widgetHost;
const waitFor = async predicate => {
  const until = Date.now() + 30000;
  while (!predicate()) { insist(Date.now() < until, 'socket-event-missing'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
export async function browserJourney({ origin, owner, email, password, widgetKey, revisit }, chromium) {
  hostedOrigin(origin);
  insist(chromium?.launch && owner?.projectId && password, 'browser-unconfigured');
  const browser = await chromium.launch({ headless: true });
  let server;
  try {
    const errors = [];
    const watch = page => page.on('pageerror', () => errors.push('page-error'));
    const operator = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); watch(operator);
    await operator.goto(origin + '/login');
    await operator.getByLabel('Email', { exact: true }).fill(email);
    await operator.getByLabel('Password', { exact: true }).fill(password);
    await operator.getByRole('button', { name: 'Login', exact: true }).click();
    await operator.waitForURL('**/conversations');
    if (revisit) {
      await operator.goto(`${origin}/projects/${owner.projectId}/conversations/${revisit.conversationId}`);
      await operator.locator('.transcript-message-content').getByText(revisit.requestContent, { exact: true }).waitFor();
      await operator.locator('.transcript-message-content').getByText(revisit.replyContent, { exact: true }).waitFor();
      await operator.reload();
      await operator.locator('.transcript-message-content').getByText(revisit.replyContent, { exact: true }).waitFor();
      insist(errors.length === 0, 'browser-startup-failed'); return { loginVerified: true };
    }
    const config = JSON.stringify({ widgetKey, apiOrigin: origin, open: true, settings: { collector: { enabled: false } } }).replaceAll('<', '\\u003c');
    server = createServer((req, res) => {
      if (req.url !== '/') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>Qualification widget host</title><script src="${origin}/widget.js"></script><script>h2h("init",${config})</script>`);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4179, '127.0.0.1', resolve); });
    const widget = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); watch(widget);
    const events = [];
    widget.on('websocket', socket => {
      const url = new URL(socket.url()), match = /^\/api\/conversations\/([^/]+)\/socket$/.exec(url.pathname);
      if (url.host !== new URL(origin).host || !match) return;
      socket.on('framereceived', ({ payload }) => {
        try { const event = JSON.parse(String(payload)); if (event.message && event.eventId) events.push({
          conversationId: match[1], messageId: event.message.id, eventId: String(event.eventId), contentSha256: digest(event.message.content),
        }); } catch { errors.push('socket-payload-invalid'); }
      });
    });
    const marker = randomBytes(16).toString('hex'), requestContent = 'Qualification request ' + marker;
    const replyContent = 'Qualification reply ' + marker, bytes = Buffer.from('Qualification media ' + marker);
    await widget.goto(widgetHost);
    await widget.locator('textarea[name=content]').waitFor({ state: 'visible' });
    await widget.locator('input[type=file]').setInputFiles({ name: 'qualification.txt', mimeType: 'text/plain', buffer: bytes });
    await widget.locator('.happytohelp-files li').waitFor({ state: 'visible' });
    await widget.locator('textarea[name=content]').fill(requestContent);
    // The public widget uploads selected files as part of Send, not selection.
    const mediaResponse = widget.waitForResponse(r => new URL(r.url()).pathname.endsWith('/media') && r.request().method() === 'POST');
    const visitorResponse = widget.waitForResponse(r => /^\/api\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await widget.locator('button[name=submit]').click();
    const uploaded = await mediaResponse; insist(uploaded.status() === 201, 'browser-media-upload-failed');
    const media = await uploaded.json();
    const sentResponse = await visitorResponse; insist(sentResponse.status() === 200, 'browser-message-rejected');
    const sent = await sentResponse.json(); insist(sent.accepted && sent.message?.id && !sent.generationError, 'browser-message-failed');
    const storageKey = `rer-widget:${origin}:${widgetKey}`;
    const identity = await widget.evaluate(key => {
      const s = JSON.parse(localStorage.getItem(key));
      return { conversationId: s.conversationId, contactId: s.contactId, projectId: s.projectId };
    }, storageKey);
    insist(identity.projectId === owner.projectId, 'browser-project-mismatch');
    await operator.goto(`${origin}/projects/${owner.projectId}/conversations/${identity.conversationId}`);
    await operator.locator('.transcript-message-content').getByText(requestContent, { exact: true }).waitFor();
    await operator.getByPlaceholder('Type your reply…').fill(replyContent);
    const operatorResponse = operator.waitForResponse(r => new URL(r.url()).pathname === `/api/conversations/${identity.conversationId}/messages` && r.request().method() === 'POST');
    await operator.getByRole('button', { name: 'Send', exact: true }).click();
    const repliedResponse = await operatorResponse; insist(repliedResponse.status() === 200, 'browser-reply-rejected');
    const replied = await repliedResponse.json(); insist(replied.accepted && replied.message?.actor_role === 'owner' && !replied.generationError, 'browser-reply-failed');
    await operator.locator('.transcript-message-content').getByText(replyContent, { exact: true }).waitFor();
    await widget.getByText(replyContent, { exact: true }).waitFor();
    const expectedReply = e => e.conversationId === identity.conversationId &&
      e.messageId === replied.message.id && e.contentSha256 === digest(replyContent);
    await waitFor(() => events.some(expectedReply));
    const delivered = events.find(expectedReply);
    events.length = 0;
    await widget.reload();
    // A REST refresh can render the correct transcript while a socket replays
    // corrupted content. Require the same event AND bytes, then verify the UI
    // after that replay has arrived, rather than accepting a prior render.
    await waitFor(() => events.some(e => expectedReply(e) && e.eventId === delivered.eventId));
    await widget.getByText(replyContent, { exact: true }).waitFor();
    const resumed = await widget.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return { conversationId: s.conversationId, contactId: s.contactId }; }, storageKey);
    insist(resumed.conversationId === identity.conversationId && resumed.contactId === identity.contactId, 'widget-resume-failed');
    await operator.reload(); await operator.locator('.transcript-message-content').getByText(replyContent, { exact: true }).waitFor();
    await widget.setViewportSize({ width: 390, height: 844 });
    const panel = await widget.locator('.happytohelp-interact').boundingBox();
    insist(panel && panel.width <= 390, 'widget-mobile-overflow');
    insist(errors.length === 0, 'browser-startup-failed');
    const script = await request(origin + '/widget.js'); insist(script.status === 200, 'widget-script-failed');
    return { conversationId: identity.conversationId, requestContent, replyContent,
      widget: { origin, scriptSha256: digest(script.text), pageErrors: 0, desktop: true, mobile: true },
      reply: { conversationId: identity.conversationId, visitorId: identity.contactId, visitorMessageId: sent.message.id,
        operatorMessageId: replied.message.id, requestSha256: digest(requestContent), replySha256: digest(replyContent),
        socketEventId: delivered.eventId, reloadVerified: true, replayVerified: true },
      media: { conversationId: identity.conversationId, mediaId: media.id, sha256: digest(bytes), size: bytes.length } };
  } finally {
    try { await browser.close(); }
    finally { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  }
}
