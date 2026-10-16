import { connect } from 'node:tls';

// A new Custom Domain answers TLS only once Cloudflare has issued its
// certificate: about 153 s on a fresh zone (dm-lanyard-1, October 2026), with
// browsers seeing ERR_SSL_VERSION_OR_CIPHER_MISMATCH meanwhile. After the
// deploy, wait on every demo hostname for a handshake that verifies the
// certificate for that name, so the deploy's readback and first visitors
// meet a working host. Addresses come from public DNS over HTTPS, so a local
// resolver's cached "no such host" for a new name cannot stall the wait. A
// failed or unverified handshake is never success: the wait ends in an error
// naming the last thing each host answered.
export async function awaitCertificates({ hostnames, report, resolve = publicAddress, port = 443, ca, timeout = 10 * 60_000, interval = 10_000, attemptTimeout = 10_000 }) {
  const deadline = Date.now() + timeout, pending = new Set(hostnames), last = new Map();
  for (let attempt = 1; ; attempt++) {
    for (const hostname of pending) {
      let seen;
      try {
        const address = await resolve(hostname, attemptTimeout);
        if (!address) seen = 'not in public DNS yet';
        else {
          const certificate = await handshake({ address, hostname, port, ca, timeout: attemptTimeout });
          pending.delete(hostname);
          report(`TLS on ${hostname} verified (${certificate.protocol}, certificate valid to ${certificate.validTo}).`);
          continue;
        }
      } catch (error) { seen = error.code ?? error.message; }
      last.set(hostname, seen);
      report(`Waiting for the certificate on ${hostname}: ${seen} (attempt ${attempt}).`);
    }
    if (!pending.size) return;
    if (Date.now() + interval >= deadline) {
      throw Object.assign(new Error('demo-certificate-timeout'), { hosts: [...pending].map(hostname => `${hostname}: ${last.get(hostname)}`) });
    }
    await new Promise(done => setTimeout(done, interval));
  }
}

function handshake({ address, hostname, port, ca, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, servername: hostname, rejectUnauthorized: true, ...(ca ? { ca } : {}), timeout });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate(), protocol = socket.getProtocol(), authorized = socket.authorized;
      socket.destroy();
      if (!authorized) reject(Object.assign(new Error('certificate not verified'), { code: socket.authorizationError ?? 'UNVERIFIED' }));
      else resolve({ protocol, validTo: certificate.valid_to });
    });
    socket.once('timeout', () => { socket.destroy(); reject(Object.assign(new Error('handshake timed out'), { code: 'ETIMEDOUT' })); });
    socket.once('error', reject);
  });
}

async function publicAddress(hostname, timeout) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`public DNS answered ${response.status}`);
  return (await response.json()).Answer?.find(record => record.type === 1)?.data ?? null;
}
