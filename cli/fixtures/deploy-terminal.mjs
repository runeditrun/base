import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Bridge a CLI subprocess to the existing fake owner account and hosted origin.
export async function terminalDeploy(t, root) {
 const edge = createServer(async (request, response) => {
  try {
   const chunks = []; for await (const chunk of request) chunks.push(chunk);
   const bytes = Buffer.concat(chunks), headers = { ...request.headers, Origin: request.headers.origin, Authorization: request.headers.authorization, 'Content-Length': request.headers['content-length'] };
   const body = request.headers['content-type']?.startsWith('multipart/form-data') ? await new Response(bytes, { headers }).formData() : bytes.toString();
   const reply = await fetch(request.headers['x-test-destination'], { method: request.method, headers, redirect: request.headers['x-test-redirect'], ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {}) });
   response.writeHead(reply.status, Object.fromEntries(reply.headers)); response.end(Buffer.from(await reply.arrayBuffer()));
  } catch { response.writeHead(500); response.end(); }
 });
 await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
 t.after(async () => { edge.closeAllConnections(); await new Promise(resolve => edge.close(resolve)); });
 return async environment => {
  const { stdout } = await promisify(execFile)('python3', [fileURLToPath(new URL('./terminal-deploy.py', import.meta.url)), root, process.execPath,
   fileURLToPath(new URL('../../bin/rer.mjs', import.meta.url)), environment], { timeout: 40000, env: { ...process.env,
    AUTH_TEST_DEPLOY_EDGE: `http://127.0.0.1:${edge.address().port}`, AUTH_TEST_DEPLOY_ORIGIN: `https://fixture-${environment}.fixture-account.workers.dev`,
    NODE_OPTIONS: `--import=${fileURLToPath(new URL('./deploy-network.mjs', import.meta.url))}` } });
  return JSON.parse(stdout);
 };
}
