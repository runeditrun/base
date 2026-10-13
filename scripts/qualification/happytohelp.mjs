import { randomBytes } from 'node:crypto';
import { jsonRequest, request } from './http.mjs';
import { insist, digest } from './operations.mjs';
import { selectMailbox } from './mailbox.mjs';
import { widgetHostOrigin } from './browser.mjs';

export const widgetPath = '/widget.js';
export function client(origin) {
  return (path, body, token, method = body === undefined ? 'GET' : 'POST', expected = 200) => jsonRequest(origin + path, {
    method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}
export async function claimAndReply({ origin, env, observe, browser, beforePhase = () => {} }) {
  beforePhase('owner');
  const call = client(origin), password = randomBytes(32).toString('hex');
  const setup = await call('/api/identity/setup');
  insist(setup.available === true && setup.tokenRequired === true, 'fresh-token-setup-required');
  const owner = await call('/api/identity/bootstrap', { name: 'Standalone qualification', ownerName: 'Qualification owner',
    email: env.T016_TEST_MAILBOX, password, allowedOrigin: widgetHostOrigin,
    setupToken: env.H2H_SETUP_TOKEN }, undefined, 'POST', 201);
  insist(owner.projectId && owner.userId && owner.token, 'owner-claim-failed');
  const actor = await call('/api/identity/session', undefined, owner.token), closed = await call('/api/identity/setup');
  insist(actor.id === owner.userId && actor.projectId === owner.projectId && actor.role === 'owner' && closed.available === false, 'owner-readback-failed');
  const project = await call(`/api/identity/projects/${owner.projectId}`, undefined, owner.token);
  insist(project.widget_key, 'widget-key-missing');
  beforePhase('reply'); insist(typeof browser === 'function', 'hosted-browser-required');
  const input = { origin, owner: { projectId: owner.projectId, userId: owner.userId },
    email: env.T016_TEST_MAILBOX, password, widgetKey: project.widget_key };
  const journey = await browser(input);
  const transcript = await call(`/api/conversations/${journey.conversationId}/messages`, undefined, owner.token);
  for (const [id, role, content] of [[journey.reply.visitorMessageId, 'contact', journey.requestContent],
    [journey.reply.operatorMessageId, 'owner', journey.replyContent]]) {
    insist(Array.isArray(transcript.messages) && transcript.messages.some(message =>
      message.id === id && message.actor_role === role && message.conversation_id === journey.conversationId &&
      message.content === content), 'reply-readback-failed');
  }
  observe('owner', { ownerId: owner.userId, projectId: owner.projectId, setupClosed: true, loginVerified: true });
  observe('widget', journey.widget); observe('reply', journey.reply);
  const state = { owner, password, browserInput: input, ...journey };
  const media = await readMedia(origin, state);
  insist(media === journey.media.sha256, 'media-readback-mismatch');
  observe('media', journey.media);
  return state; // private generated password remains in memory only through rollback
}
export async function readMedia(origin, state) {
  const result = await request(`${origin}/api/conversations/${state.conversationId}/media/${state.media.mediaId}`,
    { headers: { Authorization: `Bearer ${state.owner.token}` } });
  insist(result.status === 200, 'media-readback-failed'); return digest(result.bytes);
}
export async function ownerRecheck(origin, state, browser) {
  const login = await client(origin)('/api/identity/login', { email: state.browserInput.email, password: state.password });
  insist(login.actor?.id === state.owner.userId && login.actor.projectId === state.owner.projectId && login.actor.role === 'owner', 'owner-login-lost');
  const result = await browser({ ...state.browserInput, revisit: { conversationId: state.conversationId,
    requestContent: state.requestContent, replyContent: state.replyContent } });
  insist(result.loginVerified === true, 'owner-ui-access-lost'); return true;
}
export async function sendAndReadMail({ origin, env, state, observe, deliveryReadback, beforePhase = () => {} }) {
  const call = client(origin), token = state.owner.token, projectId = state.owner.projectId;
  const mailbox = selectMailbox(env);
  beforePhase('mailbox'); const before = await mailbox.snapshot();
  beforePhase('sendgrid');
  const idempotencyKey = `t016-${randomBytes(16).toString('hex')}`;
  await call(`/api/management/projects/${projectId}/email-settings`, { from_address: env.T016_SENDGRID_FROM,
    from_name: `Qualification ${idempotencyKey}`, is_enabled: true }, token, 'PUT');
  insist((await call(`/api/management/projects/${projectId}/email-settings`, undefined, token)).configured === true, 'sendgrid-unconfigured');
  const sentAfter = Date.now();
  const sent = await call(`/api/management/projects/${projectId}/email-settings/test`, { idempotencyKey }, token);
  insist(sent.state === 'sent' && typeof sent.id === 'string' && sent.id.length > 0, 'sendgrid-receipt-missing');
  const durable = await deliveryReadback(idempotencyKey);
  insist(durable.state === 'sent' && durable.provider_id === sent.id, 'sendgrid-durable-readback-failed');
  observe('sendgrid', { provider: 'sendgrid', providerMessageId: sent.id, correlation: idempotencyKey, state: durable.state });
  beforePhase('mailbox'); observe('mailbox', await mailbox.readNew(before, env.T016_SENDGRID_FROM, sentAfter, idempotencyKey));
}
