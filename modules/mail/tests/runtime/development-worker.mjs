import { createMailSender } from '../../index.mjs';

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/send' && request.method === 'POST') {
      return Response.json(await createMailSender({ provider: 'development', mode: 'development' }).send(await request.json()));
    }
    return new Response('Not found', { status: 404 });
  },
};
