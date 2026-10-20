// Seed tests use owner-controlled Worker custom domains. Registration checks
// the account's authoritative Worker route as well as DNS; arbitrary origins
// cannot be made safe by checking DNS then letting fetch resolve a second time.
export function seedTarget(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.runeditrun\.com$/.test(url.hostname)) {
    throw new Error('Seed target requires an owner-controlled runeditrun.com Worker custom domain');
  }
  return url;
}

function publicAddress(address: string): boolean {
  if (address.includes(':')) {
    // Only global unicast; exclude special-purpose, documentation and tunnel ranges.
    return /^[23][0-9a-f]{3}:/i.test(address) && !/^(2001:|2002:|3fff:)/i.test(address);
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return a > 0 && a < 224 && ![10, 127].includes(a) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}

export async function requirePublicDns(hostname: string): Promise<void> {
  const answers = await Promise.all([1, 28].map(async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Seed DNS lookup failed'); }
    const result = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (result.Status !== 0) throw new Error('Seed DNS lookup failed');
    return (result.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Seed DNS is not entirely public');
}
