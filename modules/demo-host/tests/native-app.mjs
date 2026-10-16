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
      await env.DB.prepare("INSERT OR IGNORE INTO items VALUES('sample')").run();
      return new Response('ready');
    }
    if (!(request.headers.get('cookie') ?? '').split(';').some(part => part.trim() === `owner=${env.SESSION_SECRET}`)) return new Response('Unauthorized', { status: 401 });
    if (request.method === 'POST') await env.DB.batch([env.DB.prepare('INSERT INTO items VALUES(?)').bind(await request.text())]);
    return Response.json((await env.DB.prepare('SELECT name FROM items ORDER BY name').all()).results);
  },
};
