// Test-only native proof acquisition, using the seed's signed-in human door.
export default async function prove({ request, tool, args, agentId }) {
 const response = await request('/app/native-proof', { method: 'POST', body: JSON.stringify({ tool, id: args.id, agentId }) });
 if (!response.ok) throw new Error(`Native proof handoff returned ${response.status}`);
 return (await response.json()).reference;
}
