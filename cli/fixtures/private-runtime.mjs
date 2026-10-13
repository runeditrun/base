import assert from 'node:assert/strict';
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { forwardingProxy, pause } from './reference.mjs';

export const privatePaths = root => [
 '/x.rer', '/exports/a.rer', '/.seed/installer/', '/.wrangler/',
 '/.rer/local/dev-key.env', '/cdn-cgi/local/explorer/api/d1',
 '/.git/config', '/.dev.vars.previous', '/.env.local',
 `/@fs${root}/.rer/local/dev-key.env`, `/@fs${root}/exports/a.rer`,
].flatMap(raw => { const path = raw.replaceAll(' ', '%20'); return [...new Set([path, path.replaceAll('.', '%2e').replace('exports', '%65xports').replace('cdn-cgi', '%63dn-cgi'), path.replaceAll('.', '%252e').replace('exports', '%2565xports').replace('cdn-cgi', '%2563dn-cgi'), path.toUpperCase()])]; });

// Preserve the raw request path: URL/fetch normalization can remove encoded
// dot segments before they ever reach the actual listener.
export function status(origin, path, host) {
 const url = new URL(origin);
 return new Promise((resolve, reject) => {
  const req = request({ hostname: url.hostname, port: url.port, path, headers: host ? { Host: host } : {}, timeout: 5000 }, response => {
   response.resume(); response.once('end', () => resolve(response.statusCode));
  });
  req.once('timeout', () => req.destroy(Error('HTTP probe timed out'))); req.once('error', reject); req.end();
 });
}
export async function privateRuntime(origin, root, { kind, runtime, child, assertPrivate = true, evidence = process.env.RER_TEST_EVIDENCE_DIRECTORY } = {}) {
 if (child) {
  const deadline = Date.now() + 15 * 60_000;
  while (await status(origin, '/health').catch(() => 0) !== 200) {
   assert.equal(child.exitCode, null, 'setup must reach its real temporary runtime');
   assert.ok(Date.now() < deadline, 'setup runtime health deadline'); await pause(25);
  }
 }
 const proxy = await forwardingProxy(origin);
 let rows;
 try {
  // Sample while the real application answers health, not just while the
  // proxy has bound its port during setup's build.
  assert.equal(await status(origin, '/health'), 200);
  rows = await Promise.all(privatePaths(root).flatMap(path => [
   { transport: 'direct', origin }, { transport: 'forged Host', origin, host: 'attacker.example' }, { transport: 'Host-rewriting proxy', origin: proxy.url },
  ].map(async transport => ({ path, transport: transport.transport, status: await status(transport.origin, path, transport.host) }))));
 } finally { await proxy.close(); }
 if (evidence) await writeFile(join(evidence, `${kind}-${runtime}.json`), JSON.stringify({ kind, runtime, rows }, null, 2) + '\n');
 // The listener refuses a Host that is not its own (421) before it looks at the path.
 if (assertPrivate) for (const row of rows) assert.equal(row.status, row.transport === 'forged Host' ? 421 : 404, `${runtime}: ${row.path} (${row.transport})`);
 return rows;
}
