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
 const failureAt = async load => {
  const preload = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
os.loadavg = () => [${load}, 0, 0]; os.availableParallelism = () => 4; syncBuiltinESMExports();`;
  const args = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, check, seed, '--origin', origin, '--pages', '/', '--details'];
  const failure = await run(process.execPath, args, { timeout: 30000 }).then(() => null, error => error);
  assert.equal(failure?.code, 1, failure?.stderr);
  const diagnostic = /^  \/ plain load:.*$/m.exec(failure.stderr);
  assert.ok(diagnostic, failure.stderr);
  return { diagnostic: diagnostic[0], elapsed: JSON.parse(failure.stderr.slice(failure.stderr.indexOf('\n{') + 1)).ms };
 };
 const idle = await failureAt(0);
 assert.doesNotMatch(idle.diagnostic, /within \d+ ms/);
 const loaded = await failureAt(8);
 const reported = /within (\d+) ms/.exec(loaded.diagnostic);
 assert.ok(reported, loaded.diagnostic);
 const bound = Number(reported[1]);
 assert.ok(bound > idle.elapsed && bound <= loaded.elapsed, `idle waited ${idle.elapsed} ms, loaded waited ${loaded.elapsed} ms and reported ${bound} ms`);
});
