import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHost } from '../host.mjs';

// Two visitors' demo containers through the host's public door, on the
// workerd engine with the demo egress. The demo's hosts are reserved .example
// names: a fetch that left the container could not reach them.
test('a demo container reads its own declared hosts as the same visitor, with no egress, and other egress keeps its refusals', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-own-hosts-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 for (const dir of ['dist/server', 'dist/client']) await mkdir(join(root, dir), { recursive: true });
 await writeFile(join(root, 'dist/server/index.mjs'), `
  export default {async fetch(request, env) {
   const url = new URL(request.url);
   if (url.pathname === '/public') return new Response('visitor ' + env.VISITOR + ' on ' + url.host + ' from ' + request.headers.get('cf-connecting-ip') + ' ' + (request.headers.get('cookie') ?? 'no cookie'));
   if (url.pathname === '/moved') return new Response(null, {status: 303, headers: {location: '/public'}});
   if (url.pathname !== '/check') return new Response('not found', {status: 404});
   try {
    const response = await fetch(url.searchParams.get('url'), {headers: {cookie: 'reader=1', 'x-rer-ingress-origin': 'https://attacker.example'}});
    return new Response(response.status + ' ' + await response.text());
   } catch (error) { return new Response('refused ' + error.message); }
  }};
 `);
 await writeFile(join(root, 'container.json'), JSON.stringify({ engine: 'workerd', entry: 'dist/server/index.mjs', config: { compatibility_date: '2026-09-01', assets: { run_worker_first: true } }, migrations: {} }));
 const primary = 'https://demo.run-test.example', page = 'https://page.demo.run-test.example';
 const visitor = async name => {
  const data = join(root, name); await mkdir(data); await writeFile(join(data, 'host.lock'), '');
  const host = await startHost({ root, data, port: 0, automaticTicks: false, runnerEnabled: false,
   settings: { VISITOR: name, RER_DEMO: '1', RER_INGRESS_ORIGIN: primary, RER_INGRESS_ORIGINS: JSON.stringify([primary, page]) } });
  t.after(() => host.close());
  return async target => (await fetch(`http://127.0.0.1:${host.server.address().port}/check?url=${encodeURIComponent(target)}`)).text();
 };
 const a = await visitor('a'), b = await visitor('b');
 assert.equal(await a(`${page}/public`), '200 visitor a on page.demo.run-test.example from 127.0.0.1 reader=1');
 assert.equal(await b(`${page}/public`), '200 visitor b on page.demo.run-test.example from 127.0.0.1 reader=1');
 assert.equal(await a(`${primary}/moved`), '200 visitor a on demo.run-test.example from 127.0.0.1 reader=1');
 assert.equal(await b(`${page}/moved`), '200 visitor b on page.demo.run-test.example from 127.0.0.1 reader=1');
 assert.equal(await a('https://api.sendgrid.com/v3/mail/send'), 'refused Demo direct messaging transport refused');
});
