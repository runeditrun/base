import { createMailSender } from '../../index.mjs';
import { createD1DevelopmentOutbox, createDevelopmentOutboxHandler } from '../../src/development/index.mjs';

export default {
  async fetch(request, env) {
    const outbox = createD1DevelopmentOutbox({ db: env.DB });
    if (new URL(request.url).pathname === '/capture' && request.method === 'POST') {
      const message = await request.json();
      if (message.attachments) message.attachments = message.attachments.map(attachment => ({ ...attachment, content: Uint8Array.from(attachment.content) }));
      const sender = createMailSender({ provider: 'development', mode: 'development' }, { outbox });
      return Response.json(await sender.send(message));
    }
    const viewer = createDevelopmentOutboxHandler({ local: request.headers.get('X-Test-Production') !== 'true', origin: env.LOCAL_ORIGIN, outbox });
    return await viewer(request) ?? new Response('Not found', { status: 404 });
  },
};
