import { DurableObject } from 'cloudflare:workers';
import { verifyOwnerClaim } from '../../owner-claim/verify.mjs';
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/auth/owner-claim') {
      await verifyOwnerClaim(new URLSearchParams(await request.text()).get('token'), { issuer: env.RER_OWNER_CLAIM_ISSUER,
        installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID, appOrigin: env.AUTH_ORIGIN,
        expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) });
      await env.DB.prepare('INSERT INTO owner VALUES(?)').bind(env.OWNER_EMAIL).run();
      return new Response(null, { status: 303, headers: { location: '/items', 'set-cookie': `owner=${env.SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (path === '/health') {
      await env.JOBS.metrics();
      const legacy = await env.LEGACY.getByName('same-name').fetch('https://legacy/');
      if (await legacy.text() !== 'present') throw new Error('Legacy Durable Object failed');
      await env.DB.prepare("INSERT OR IGNORE INTO items VALUES('sample')").run();
      return new Response('ready');
    }
    if (!(request.headers.get('cookie') ?? '').split(';').some(part => part.trim() === `owner=${env.SESSION_SECRET}`)) return new Response('Unauthorized', { status: 401 });
    if (path === '/socket') return env.COUNTER.getByName('socket').fetch(request);
    if (path === '/bindings') {
      const retained = env.COUNTER.getByName('same-name');
      if (request.method === 'POST') {
        const body = await request.text();
        const upload = await env.FILES.createMultipartUpload('multipart');
        const part = await upload.uploadPart(1, new Response(new Uint8Array([1, 2, 3])).body);
        await upload.complete([part]);
        if ((await (await env.FILES.get('multipart')).arrayBuffer()).byteLength !== 3) throw new Error('Multipart bytes lost');
        await env.FILES.delete(['multipart']);
        const abandoned = await env.FILES.createMultipartUpload('abandoned');
        await abandoned.uploadPart(1, new Uint8Array([4]));
        await env.FILES.put('attachment', new Response(body).body, { httpMetadata: { contentType: 'text/plain' } });
        await env.SECOND.prepare('INSERT INTO items VALUES(?)').bind(body).run();
        await env.JOBS.send({ body });
        return new Response(null, { status: 201 });
      }
      const attachment = await env.FILES.get('attachment');
      const head = await env.FILES.head('attachment');
      if (attachment && head.httpMetadata.contentType !== 'text/plain') throw new Error('Lost R2 metadata');
      return Response.json({ keys: (await env.FILES.list()).objects.map(item => item.key), body: attachment ? await attachment.text() : null,
        retained: await (await retained.fetch('https://counter/')).json(), jobs: (await env.DB.prepare('SELECT name FROM jobs').all()).results,
        secondary: (await env.SECOND.prepare('SELECT name FROM items').all()).results });
    }
    if (request.method === 'POST') await env.DB.batch([env.DB.prepare('INSERT INTO items VALUES(?)').bind(await request.text())]);
    return Response.json((await env.DB.prepare('SELECT name FROM items ORDER BY name').all()).results);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      if (message.attempts === 1) { message.retry({ delaySeconds: 0 }); continue; }
      const object = await env.FILES.get('attachment');
      await env.COUNTER.getByName('same-name').fetch('https://counter/', { method: 'PUT', body: await object.text() });
      await env.DB.prepare('INSERT INTO jobs VALUES(?)').bind(message.body.body).run();
      message.ack();
    }
  },
};
export class Counter extends DurableObject {
  async fetch(request) {
    if (request.headers.get('upgrade') === 'websocket') {
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    await this.env.SECOND.prepare('SELECT name FROM items').all();
    if (request.method === 'PUT') await this.ctx.storage.put('retained', await request.text());
    return Response.json(await this.ctx.storage.get('retained') ?? null);
  }
  webSocketMessage(socket, message) { socket.send(message); }
}

// Legacy DO exports (without the RPC base class) are used by real seeds too.
export class LegacyCounter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch() { await this.ctx.storage.put('retained', 'present'); return new Response(await this.ctx.storage.get('retained')); }
}
