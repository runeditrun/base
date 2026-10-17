import { DurableObject } from 'cloudflare:workers';
import { verifyOwnerClaim } from '../../owner-claim/verify.mjs';
import add from './native-add.wasm';
import data from './native-data.bin';
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/auth/owner-claim') {
      await verifyOwnerClaim(new URLSearchParams(await request.text()).get('token'), { issuer: env.RER_OWNER_CLAIM_ISSUER,
        installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID, appOrigin: env.AUTH_ORIGIN,
        expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) });
      await env.DB.prepare('INSERT INTO owner VALUES(?)').bind(env.OWNER_EMAIL).run();
      return new Response(null, { status: 303, headers: { location: '/items', 'set-cookie': `owner=${env.SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (path === '/health') {
      await env.COUNTER.getByName('health').noteClient(request.headers.get('cf-connecting-ip'));
      await env.JOBS.metrics();
      const legacy = await env.LEGACY.getByName('same-name').fetch('https://legacy/');
      if (await legacy.text() !== 'present') throw new Error('Legacy Durable Object failed');
      await env.DB.prepare("INSERT OR IGNORE INTO items VALUES('sample')").run();
      return new Response('ready');
    }
    if (path === '/health-client') return Response.json(await env.COUNTER.getByName('health').noteClient());
    if (path === '/own-data') return Response.json((await env.DB.prepare('SELECT name FROM items ORDER BY name').all()).results.map(row => row.name));
    if (!(request.headers.get('cookie') ?? '').split(';').some(part => part.trim() === `owner=${env.SESSION_SECRET}`)) return new Response('Unauthorized', { status: 401 });
    if (path === '/auth/signout' && request.method === 'POST') return new Response(null, { status: 204, headers: { 'set-cookie': 'owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' } });
    if (path === '/own-fetch') {
      const primary = await (await fetch(env.AUTH_ORIGIN + '/own-data')).json();
      const secondary = await (await fetch('https://page.demo.example.test/own-data')).json();
      let messaging = 'sent';
      try { await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: 'fixture-message' }); }
      catch (error) { messaging = error.message; }
      return Response.json({ primary, secondary, messaging, network: await (await fetch('https://network.example.test/')).text() });
    }
    if (path === '/bridge-probe') {
      const result = {};
      for (const method of ['capacity', 'diagnostic', 'begin', 'erase', 'session', 'status', 'active', 'end', 'save', 'schedule']) {
        try { await env.RER_NATIVE_HOST[method](); result[method] = 'reachable'; }
        catch { result[method] = 'denied'; }
      }
      result.fetch = (await env.RER_NATIVE_HOST.fetch(new Request(env.AUTH_ORIGIN + '/items'))).status === 404 ? 'denied' : 'reachable';
      return Response.json(result);
    }
    if (path === '/d1-session') {
      const session = env.DB.withSession('first-primary');
      const [items] = await session.batch([session.prepare('SELECT name FROM items ORDER BY name')]);
      // An unknown D1 method reads undefined, as on real D1, and its first read warns once.
      const warnings = [], warn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      let unknown;
      try { unknown = [env.DB.notD1, env.DB.notD1, session.notD1]; } finally { console.warn = warn; }
      return Response.json({ names: items.results.map(row => row.name), bookmark: typeof session.getBookmark(), unknown: unknown.every(value => value === undefined),
        warnings: warnings.filter(line => /^D1_UNSUPPORTED: D1Database\.notD1\b/.test(line)).length });
    }
    if (path === '/modules') return Response.json({ sum: new WebAssembly.Instance(add).exports.add(2, 3), data: [...new Uint8Array(data)] });
    if (path === '/legacy-alarm') return env.LEGACY.getByName('same-name').fetch('https://legacy/alarm-status');
    if (path === '/alarms') {
      const object = env.COUNTER.getByName('alarm');
      if (request.method === 'POST') await object.arm();
      return Response.json(await object.alarmStatus());
    }
    if (path === '/socket') return env.COUNTER.getByName('socket').fetch(request);
    if (path === '/r2') return Response.json(await r2RoundTrip(env.FILES));
    if (path === '/bindings') {
      const retained = env.COUNTER.getByName('same-name');
      if (request.method === 'POST') {
        const body = await request.text();
        const upload = await env.FILES.createMultipartUpload('multipart');
        const part = await upload.uploadPart(1, new Response(new Uint8Array([1, 2, 3])).body);
        await upload.complete([part]);
        if ((await (await env.FILES.get('multipart')).arrayBuffer()).byteLength !== 3) throw new Error('Multipart bytes lost');
        await env.FILES.delete(['multipart']);
        const abandoned = await env.FILES.createMultipartUpload('abandoned');
        await abandoned.uploadPart(1, new Uint8Array([4]));
        await env.FILES.put('attachment', new Response(body).body, { httpMetadata: { contentType: 'text/plain' } });
        await env.SECOND.prepare('INSERT INTO items VALUES(?)').bind(body).run();
        await env.JOBS.send({ body });
        return new Response(null, { status: 201 });
      }
      const attachment = await env.FILES.get('attachment');
      const head = await env.FILES.head('attachment');
      if (attachment && head.httpMetadata.contentType !== 'text/plain') throw new Error('Lost R2 metadata');
      return Response.json({ keys: (await env.FILES.list()).objects.map(item => item.key), body: attachment ? await attachment.text() : null,
        retained: await retained.read(), jobs: (await env.DB.prepare('SELECT name FROM jobs').all()).results,
        secondary: (await env.SECOND.prepare('SELECT name FROM items').all()).results });
    }
    if (request.method === 'POST') await env.DB.batch([env.DB.prepare('INSERT INTO items VALUES(?)').bind(await request.text())]);
    return Response.json((await env.DB.prepare('SELECT name FROM items ORDER BY name').all()).results);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      if (message.attempts === 1) { message.retry({ delaySeconds: 0 }); continue; }
      const object = await env.FILES.get('attachment');
      await env.COUNTER.getByName('same-name').fetch('https://counter/', { method: 'PUT', body: await object.text() });
      await env.DB.prepare('INSERT INTO jobs VALUES(?)').bind(message.body.body).run();
      message.ack();
    }
  },
};
export class Counter extends DurableObject {
  async fetch(request) {
    if (request.headers.get('upgrade') === 'websocket') {
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    await this.env.SECOND.prepare('SELECT name FROM items').all();
    if (request.method === 'PUT') await this.ctx.storage.put('retained', await request.text());
    return Response.json(await this.ctx.storage.get('retained') ?? null);
  }
  async read() {
    await this.env.DB.prepare('SELECT name FROM items').all();
    return await this.ctx.storage.get('retained') ?? null;
  }
  async noteClient(ip) {
    if (ip !== undefined) await this.ctx.storage.put('client', ip);
    return await this.ctx.storage.get('client') ?? null;
  }
  async arm() {
    await this.ctx.storage.setAlarm(new Date(Date.now() + 60000));
    if (!await this.ctx.storage.getAlarm()) throw new Error('Alarm was not saved');
    await this.ctx.storage.deleteAlarm();
    if (await this.ctx.storage.getAlarm() !== null) throw new Error('Alarm was not deleted');
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }
  async alarm(info) {
    const attempts = (await this.ctx.storage.get('attempts') ?? 0) + 1;
    await this.ctx.storage.put('attempts', attempts);
    if (attempts === 1) throw new Error('fixture first delivery fails');
    if (!info.isRetry || info.retryCount !== 1) throw new Error('Missing retry information');
    await this.ctx.storage.put({ fired: true, during: await this.ctx.storage.getAlarm() });
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  async alarmStatus() {
    return { fired: await this.ctx.storage.get('fired') ?? false, attempts: await this.ctx.storage.get('attempts') ?? 0,
      during: await this.ctx.storage.get('during') ?? null, next: await this.ctx.storage.getAlarm() };
  }
  webSocketMessage(socket, message) { socket.send(message); }
}

// Legacy DO exports (without the RPC base class) are used by real seeds too.
export class LegacyCounter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (new URL(request.url).pathname === '/alarm-status') return Response.json(await this.ctx.storage.get('fired') ?? false);
    await this.ctx.storage.put('retained', 'present');
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return new Response(await this.ctx.storage.get('retained'));
  }
  async alarm() { await this.ctx.storage.put('fired', true); }
}

// The R2 surface seeds use, against the visitor's own storage.
async function r2RoundTrip(files) {
  const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const page = async options => { const listed = await files.list(options); return { keys: listed.objects.map(item => item.key), prefixes: listed.delimitedPrefixes, truncated: listed.truncated, cursor: listed.cursor,
    metadata: listed.objects.map(item => item.customMetadata) }; };
  for (const key of ['r2/docs/a.txt', 'r2/docs/b.txt', 'r2/docs/sub/c.txt', 'r2/top.txt']) await files.put(key, key, { customMetadata: { key }, httpMetadata: { contentType: 'text/plain' } });
  const first = await page({ prefix: 'r2/docs/', limit: 1 });
  const result = { top: await page({ prefix: 'r2/', delimiter: '/' }), first: { ...first, cursor: typeof first.cursor },
    rest: (await page({ prefix: 'r2/docs/', cursor: first.cursor })).keys, after: await page({ prefix: 'r2/', startAfter: 'r2/docs/b.txt', include: ['customMetadata'] }) };
  result.after.cursor = typeof result.after.cursor;
  result.top.cursor = typeof result.top.cursor;
  const top = await files.head('r2/top.txt');
  result.ranges = [await (await files.get('r2/top.txt', { range: { offset: 3, length: 3 } })).text(), await (await files.get('r2/top.txt', { range: { suffix: 3 } })).text(),
    await (await files.get('r2/top.txt', { range: new Headers({ range: 'bytes=0-1' }) })).text()];
  result.conditional = [await files.put('r2/top.txt', 'x', { onlyIf: { etagDoesNotMatch: '*' } }), 'body' in await files.get('r2/top.txt', { onlyIf: { etagMatches: '"other"' } }),
    (await files.put('r2/top.txt', 'y', { onlyIf: new Headers({ 'if-match': top.httpEtag }) }))?.etag === (await files.head('r2/top.txt')).etag, await (await files.get('r2/top.txt')).text()];
  result.checksum = await files.put('r2/sum', 'abc', { sha256: '0'.repeat(64) }).then(() => 'accepted', error => /SHA-256 checksum/.test(error.message));
  const sum = await files.put('r2/sum', 'abc', { sha256: await hex(new TextEncoder().encode('abc')) });
  result.sha256 = [...new Uint8Array(sum.checksums.sha256)].map(byte => byte.toString(16).padStart(2, '0')).join('') === await hex(new TextEncoder().encode('abc'));
  // Six chunks streamed in, read back as a stream and across a chunk boundary.
  const big = new Uint8Array(6 * 1024 * 1024 + 5).map((_, index) => index % 251), fixed = new FixedLengthStream(big.length);
  const writer = fixed.writable.getWriter();
  await Promise.all([files.put('r2/big', fixed.readable, { httpMetadata: { contentType: 'application/x-test' } }), (async () => { for (let at = 0; at < big.length; at += 65536) await writer.write(big.slice(at, at + 65536)); await writer.close(); })()]);
  const read = await files.get('r2/big');
  result.big = { size: read.size, same: await hex(await read.arrayBuffer()) === await hex(big), edge: [...new Uint8Array(await (await files.get('r2/big', { range: { offset: 1024 * 1024 - 2, length: 4 } })).arrayBuffer())] };
  // Parts arrive out of order and complete in part order.
  const upload = await files.createMultipartUpload('r2/multi', { httpMetadata: { contentType: 'application/x-multi' } });
  const resumed = files.resumeMultipartUpload('r2/multi', upload.uploadId);
  const second = await resumed.uploadPart(2, new Uint8Array([7, 8, 9]));
  const one = await upload.uploadPart(1, new Response(big.slice(0, 1536 * 1024)).body);
  const done = await upload.complete([second, one]);
  const multi = await files.get('r2/multi');
  const bytes = new Uint8Array(await multi.arrayBuffer());
  result.multipart = { etag: /^[a-f0-9]{32}-2$/.test(done.etag), size: multi.size, contentType: multi.httpMetadata.contentType, tail: [...bytes.slice(-4)],
    across: [...new Uint8Array(await (await files.get('r2/multi', { range: { offset: 1536 * 1024 - 1, length: 2 } })).arrayBuffer())],
    missing: await files.resumeMultipartUpload('r2/multi', upload.uploadId).uploadPart(3, 'x').then(() => 'accepted', error => /multipart upload does not exist/.test(error.message)) };
  await files.delete(['r2/docs/a.txt', 'r2/docs/b.txt']);
  await files.delete('r2/big');
  result.deleted = { docs: (await page({ prefix: 'r2/docs/' })).keys, big: await files.get('r2/big'), head: await files.head('r2/docs/a.txt') };
  return result;
}
