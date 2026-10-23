import { createPortabilityHandler } from '../../modules/portability/index.mjs';

export default { async fetch(request, env) {
 const handler = await createPortabilityHandler({ db: env.DB, policy: { product: 'synthetic-hosted-portability' },
  appOrigin: new URL(request.url).origin, authorize: req => req.headers.get('Cookie') === env.TEST_COOKIE ? 'owner' : null });
 return await handler(request) ?? new Response('missing', { status: 404 });
} };
