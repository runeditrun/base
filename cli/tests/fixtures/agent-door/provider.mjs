import receiver from './receiver.mjs';
import { openAiAuthorization as OPENAI_AUTHORIZATION } from './credentials.mjs';

const refused = message => new Response(message, { status: 502 });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin === 'https://receiver.example.invalid') {
      if (env?.fixture && (await request.clone().json()).value !== env.fixture.value) return new Response('Native challenge mismatch', { status: 409 });
      return receiver.fetch(request, env);
    }
    if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses' || url.search || request.method !== 'POST') return refused('Undeclared provider operation');
    if (request.headers.get('authorization') !== OPENAI_AUTHORIZATION || request.headers.get('content-type') !== 'application/json') return refused('Invalid provider authentication or media type');
    let input;
    try { input = await request.json(); } catch { return refused('Invalid provider JSON'); }
    if (!input || Object.keys(input).sort().join(',') !== 'input,model,stream' || input.model !== 'gpt-4.1-mini'
      || typeof input.input !== 'string' || !input.input || typeof input.stream !== 'boolean'
      || request.headers.get('accept') !== (input.stream ? 'text/event-stream' : 'application/json')) return refused('Invalid Responses request');
    // Even an origin declared for app egress cannot be reached from this
    // isolated adapter. A forwarded recursive request must fail this operation.
    const recursive = await fetch('https://api.openai.com/network-denied');
    const isolated = recursive.status === 502;
    await recursive.body?.cancel();
    if (!isolated) return new Response('Adapter escaped network isolation', { status: 500 });
    const text = `Reviewed: ${input.input}`;
    const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', status: 'completed',
      output: [{ id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] };
    if (!input.stream) return Response.json(response, { headers: { 'x-fixture-recursive-network': 'denied' } });
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.completed', response },
    ];
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream', 'x-fixture-recursive-network': 'denied' } });
  },
};
