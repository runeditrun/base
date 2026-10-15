// Public-address filtering and TLS belong to NETWORK. Demo's application guard
// simulates effects on people/accounts; this is defense for direct transports.
const transports = new Set([
  'api.sendgrid.com', 'api.resend.com', 'api.twilio.com',
  'api.mailgun.net', 'api.eu.mailgun.net', 'api.postmarkapp.com',
]);
const mailPorts = new Set(['25', '465', '587', '2525']);

function check(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (transports.has(host) || mailPorts.has(url.port)) throw new TypeError('Demo direct messaging transport refused');
}

export default {
  async fetch(request, env) {
    if (env.RER_DEMO !== '1') return env.NETWORK.fetch(request);
    const redirect = request.redirect;
    for (let hops = 0; ; hops++) {
      const url = new URL(request.url);
      check(url);
      // Check every redirect before contacting its destination, including when
      // an otherwise public URL redirects into a messaging provider.
      const response = await env.NETWORK.fetch(new Request(request.clone(), { redirect: 'manual' }));
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null || redirect === 'manual') return response;
      await response.body?.cancel();
      if (redirect === 'error' || hops === 20) throw new TypeError('Demo egress redirect refused');
      const next = new URL(location, url), headers = new Headers(request.headers);
      const get = response.status === 303 && !['GET', 'HEAD'].includes(request.method) || [301, 302].includes(response.status) && request.method === 'POST';
      if (get) for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      if (next.origin !== url.origin) for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
      request = new Request(next, { method: get ? 'GET' : request.method, headers, body: get ? null : request.body, redirect, signal: request.signal, duplex: 'half' });
    }
  },
};
