import { createInterface } from 'node:readline';
import { Api } from './api.mjs';
import { mcpClient } from './questions.mjs';
import { paired } from './local-commands.mjs';
import { describe } from './errors.mjs';
import { maskDeviceText } from './run-mask.mjs';

const protocolVersion = '2025-11-25';
const forwarded = /^(tools|resources|prompts|completion|logging)\//;

/** A local stdio MCP server for an agent (Claude Code, Codex): newline-delimited JSON-RPC in, the same out. Calls go to the
 * Business MCP with a bearer minted from this computer's pairing and minted again when it nears expiry or is refused, so the
 * agent never holds a token. Only protocol messages are written to stdout; everything else goes to stderr. */
export async function bridge({ input = process.stdin, output = process.stdout, errors = process.stderr } = {}) {
 let session;
 const connection = () => session ??= (async () => {
  const { state, credential } = await paired();
  return mcpClient(new Api(state.origin, credential));
 })().catch(error => { session = undefined; throw error; });
 const send = message => output.write(maskDeviceText(JSON.stringify({ jsonrpc: '2.0', ...message })) + '\n');
 const fail = (id, code, text) => send({ id, error: { code, message: text } });

 async function handle(message) {
  const { id, method, params } = message;
  if (typeof method !== 'string') return;
  if (id === undefined || id === null) return; // A notification needs no answer.
  try {
   if (method === 'ping') return send({ id, result: {} });
   const upstream = await connection();
   if (method === 'initialize') {
    const { capabilities, instructions } = upstream.initialized;
    return send({ id, result: { protocolVersion, capabilities: capabilities ?? {}, serverInfo: { name: 'rer-business', version: '1.0.0' }, ...(typeof instructions === 'string' ? { instructions } : {}) } });
   }
   if (!forwarded.test(method)) return fail(id, -32601, `Method not found: ${method.slice(0, 80)}`);
   const response = await upstream.exchange(method, params ?? {});
   if (response.error) {
    const { code, message: text, data } = response.error;
    return send({ id, error: { code: Number.isInteger(code) ? code : -32000, message: describe(Error(String(text ?? 'Business refused the request.'))), ...(data !== undefined ? { data } : {}) } });
   }
   send({ id, result: response.result });
  } catch (error) {
   errors.write(describe(error) + '\n');
   fail(id, -32000, describe(error));
  }
 }

 const pending = new Set();
 const lines = createInterface({ input, crlfDelay: Infinity });
 for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) { fail(null, -32600, 'Invalid request'); continue; }
  const work = handle(message).finally(() => pending.delete(work));
  pending.add(work);
 }
 await Promise.all(pending);
 return 0;
}
