import { createMailSender } from '../../index.mjs';
// No injected fetch: the adapter calls this Worker's own global fetch.
export default {
  async fetch(request) {
    const sender = createMailSender({ provider: 'rer', mode: 'production', apiKey: 'f'.repeat(64), relayUrl: 'https://managed.example.test/api/managed-mail/send' });
    try { return Response.json(await sender.send(await request.json())); }
    catch (error) { return Response.json({ error: error.code ?? error.message }); }
  },
};
