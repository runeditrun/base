import { promises as dns } from 'node:dns';

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

async function records(query: () => Promise<string[]>): Promise<string[]> {
  try { return await query(); }
  catch (error) {
    // One family may be absent. NXDOMAIN, transport errors and malformed
    // answers never establish a usable target.
    if ((error as { code?: string }).code === 'ENODATA') return [];
    throw new Error('Seed DNS lookup failed');
  }
}

export async function requirePublicDns(hostname: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Workers implements these two methods with its built-in DoH resolver.
    // The deadline bounds delivery even if a resolver never settles.
    const addresses = await Promise.race([
      Promise.all([records(() => dns.resolve4(hostname)), records(() => dns.resolve6(hostname))]).then(answers => answers.flat()),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Seed DNS deadline exceeded')), 1_500); }),
    ]);
    if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Seed DNS is not entirely public');
  } finally { clearTimeout(timer); }
}
