import { createMailSender, createDeliveryEventIntake, createD1EventStore } from '../../index.mjs';

// Test-only public routes; configurable options and the HTTP double are never
// application code. D1 and all signing/intake paths are real workerd APIs.
export default {
  async fetch(request, env) {
    try {
      const input = await request.json();
      if (new URL(request.url).pathname === '/events') {
        const options = input.options ?? {};
        const source = JSON.parse(env.SOURCE);
        const intake = createDeliveryEventIntake({ provider: 'messaging', tenantId: options.tenantId ?? 'tenant', eventNamespace: options.eventNamespace ?? 'events',
          messagingSource: source, store: createD1EventStore({ db: env.DB }), clock: () => Number(env.NOW),
          authorize: event => event.deliveryId !== 'unowned' && event.recipients.every(recipient => recipient.endsWith('@example.test')) });
        // Configuration changes after construction cannot substitute trust roots.
        source.installId = 'mutated'; source.jwks.keys.splice(0);
        const result = await intake.ingestWebhook({ rawBody: new TextEncoder().encode(input.token), headers: new Headers() });
        return Response.json({ result });
      }
      const seen = [];
      const edge = async (url, init) => {
        const [head, payload, signature] = new Headers(init.headers).get('RER-Signature').split('.');
        const unurl = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const publicKey = { ...input.config.signingKey }; delete publicKey.d; delete publicKey.key_ops;
        const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unurl(signature), new TextEncoder().encode(`${head}.${payload}`));
        if (!valid) throw new Error('signature failed');
        const body = new Uint8Array(init.body ?? []);
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(value => value.toString(16).padStart(2, '0')).join('');
        const claims = JSON.parse(new TextDecoder().decode(unurl(payload)));
        if (claims.bodySha256 !== digest || claims.path !== new URL(url).pathname || claims.method !== init.method || claims.iss !== input.config.installId || claims.aud !== input.config.serviceOrigin || claims.iat !== Number(env.NOW) / 1000) throw new Error('claims failed');
        seen.push({ method: init.method, path: new URL(url).pathname, body: body.length ? JSON.parse(new TextDecoder().decode(body)) : null });
        if (init.method === 'GET') return Response.json({ deliveryId: input.message.deliveryId, messageId: 'remote', state: 'accepted', result: { provider: 'messaging', status: 'accepted', providerMessageId: 'remote' }, attempts: [], lastEvent: null });
        return Response.json(url.endsWith('/v1/erase') ? { erased: true } : { provider: 'messaging', status: 'accepted', providerMessageId: 'remote' });
      };
      for (const attachment of input.message.attachments ?? []) attachment.content = Uint8Array.from(attachment.content);
      const sender = createMailSender(input.config, { clock: () => Number(env.NOW), ...(input.binding ? { serviceBinding: { fetch: edge } } : { fetch: edge }) });
      const result = await sender.send(input.message);
      const reconciliation = await sender.reconcile(input.message.deliveryId);
      const erased = await sender.erase('Reader@example.test');
      return Response.json({ result, reconciliation, erased, seen });
    } catch (error) { return Response.json({ code: error.code ?? 'unexpected', message: error.message }, { status: 400 }); }
  },
};
