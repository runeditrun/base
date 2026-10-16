const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret) {
 return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 return `${encode(iv)}.${encode(await crypto.subtle.encrypt({name:'AES-GCM', iv}, await key(secret), new TextEncoder().encode(JSON.stringify(value))))}`;
}
export async function unseal(value, secret) {
 try {
  const [iv, body] = value.split('.');
  const data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv)}, await key(secret), decode(body))));
  return data.ends > Date.now() && /^[0-9a-f]{64}$/.test(data.id) ? data : null;
 } catch { return null; }
}
export const cookieValue = request => (request.headers.get('cookie') ?? '').split(';').map(x=>x.trim()).find(x=>x.startsWith('rer_demo='))?.slice(9);
export const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
