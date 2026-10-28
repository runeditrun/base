export default async function prove({ request, origin, person }) {
 const response = await request(new URL('/agents/api/native-proof', origin).href, { method: 'POST',
  headers: { Origin: origin, Cookie: person.cookie, 'Content-Type': 'application/json' }, body: '{}' });
 if (!response.ok) throw new Error(`Native recent sign-in proof: HTTP ${response.status}`);
 return (await response.json()).reference;
}
