import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const seed = resolve(import.meta.dirname, '../default-seed');
const check = resolve(import.meta.dirname, 'hydration/check.mjs');

test('the homepage hydration check allows a longer wait on a loaded host', async t => {
 const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><main>Homepage</main><script type="module">export {};</script>');
 });
 server.listen(0, '127.0.0.1');
 await once(server, 'listening');
 t.after(() => new Promise(resolve => server.close(resolve)));
 const origin = `http://127.0.0.1:${server.address().port}`;
 const bound = async load => {
  const preload = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
os.loadavg = () => [${load}, 0, 0]; os.availableParallelism = () => 4; syncBuiltinESMExports();`;
  const args = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, check, seed, '--origin', origin, '--pages', '/'];
  const failure = await run(process.execPath, args, { timeout: 30000 }).then(() => null, error => error);
  assert.equal(failure?.code, 1, failure?.stderr);
  const reported = /^\s*\/ plain load:.*?within (\d+) ms/m.exec(failure.stderr);
  assert.ok(reported, failure.stderr);
  return Number(reported[1]);
 };
 const idle = await bound(0);
 const loaded = await bound(5);
 assert.ok(loaded > idle, `idle ${idle} ms, loaded ${loaded} ms`);
});
