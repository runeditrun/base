// Miniflare replaces workerd on setOptions, even when port:0 resolves to the
// same address. Keep ingress in its own, never-reconfigured runtime; application
// generations can then bind fresh ephemeral sockets against the persisted D1.
export function emittedListener(Miniflare, convert, { https, compatibilityDate, fetch }) {
  return new Miniflare(convert({
    host: '127.0.0.1', port: 0, https, compatibilityDate, modules: true,
    // Carry URL and Host explicitly across both Miniflare loopback transports.
    // In particular, preserve an intentionally hostile Host for admission tests.
    script: `export default { fetch(request, env) {
      const headers = new Headers(request.headers);
      headers.set('x-base-test-url', request.url);
      headers.set('x-base-test-host', headers.get('host') ?? new URL(request.url).host);
      return env.APP.fetch(new Request(request, { headers }));
    } }`,
    serviceBindings: { APP: fetch },
  }))
}

// A generation owns a response until its stream finishes or is cancelled, not
// merely until headers arrive. Let redeploy wait for those responses to drain.
export function drainingResponse(response, finished) {
  if (!response.body) { finished(); return response }
  const reader = response.body.getReader()
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { finished(); controller.close() }
        else controller.enqueue(value)
      } catch (error) { finished(); controller.error(error) }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { finished() } },
  }), response)
}
