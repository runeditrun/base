// Public-address filtering and TLS belong to NETWORK. Demo's application guard
// simulates effects on people/accounts; this is defense for direct transports.
const transports = new Set([
  'api.sendgrid.com', 'api.resend.com', 'api.twilio.com',
  'api.mailgun.net', 'api.eu.mailgun.net', 'api.postmarkapp.com',
]);
const mailPorts = new Set(['25', '465', '587', '2525']);

// The demo's own hosts (RER_INGRESS_ORIGIN and RER_INGRESS_ORIGINS, from
// deploy-demo.json) reach the front only with the visitor's cookie, so the
// app's own read of one would leave the container and meet the start page.
// SELF is this container's ingress: the same visitor's demo, no network.
const STRIPPED = ['cf-connecting-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'forwarded', 'x-rer-original-url', 'x-rer-ingress-origin'];
function local(request, url) {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED) headers.delete(name);
  headers.set('cf-connecting-ip', '127.0.0.1'); headers.set('x-rer-original-url', url.href);
  return new Request(request, { headers, redirect: 'manual' });
}

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
      const own = JSON.parse(env.RER_DEMO_ORIGINS ?? '[]').includes(url.origin);
      if (!own) check(url);
      // Check every redirect before contacting its destination, including when
      // an otherwise public URL redirects into a messaging provider.
      const response = own ? await env.SELF.fetch(local(request.clone(), url)) : await env.NETWORK.fetch(new Request(request.clone(), { redirect: 'manual' }));
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
