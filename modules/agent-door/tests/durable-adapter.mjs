import { randomUUID } from 'node:crypto';
import { VERSION } from '../conformance/protocol.mjs';

export function durableAdapter({ origin, cookie }) {
 const dispatch = async (request, handle, action) => {
  const response = await request(`/__jobs/${encodeURIComponent(handle)}/${action}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  if (!response.ok) throw new Error(`Native job ${action}: HTTP ${response.status}`);
  return response.json();
 };
 return {
  async queue({ request, token, previous }) {
   if (previous) return (await dispatch(request, previous, 'reschedule')).id;
   const response = await request('/mcp', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'synthetic.records.write' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'synthetic.records.write', arguments: { id: randomUUID(), value: 'synthetic-base-durable', defer: true, idempotency_key: randomUUID() }, _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
   const answer = await response.json();
   if (!response.ok || answer.result?.isError || !answer.result?.structuredContent?.id) throw new Error(`Native job queue: HTTP ${response.status}`);
   return answer.result.structuredContent.id;
  },
  run: ({ request, handle }) => dispatch(request, handle, 'run'),
 };
}
