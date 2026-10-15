import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, front, cookieHeader, demoCookie } from './front.mjs';

const SECONDARY = ORIGIN.replace('://', '://page.');
const id = response => /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(response))[1];

function exchange(socket, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('WebSocket echo timed out')); }, 2000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', message);
      socket.removeEventListener('error', error);
    };
    const message = event => { cleanup(); resolve(JSON.parse(event.data)); };
    const error = event => { cleanup(); reject(event.error ?? new Error('WebSocket transport failed')); };
    socket.addEventListener('message', message);
    socket.addEventListener('error', error);
    socket.send(payload);
  });
}

test('Upgrade traverses the public front and real visitor object, with session and lifetime gates intact', async () => {
  const { mf, demos, fetch, start } = await front({ secondary: [SECONDARY] });
  const sockets = [];
  const upgrade = (path = '/api/live', cookie) => fetch(path, { headers: { upgrade: 'websocket', connection: 'Upgrade',
    ...(cookie ? { cookie } : {}), 'x-rer-ingress-origin': 'https://unrelated.example' } });
  try {
    const first = await start(), second = await start({ ip: '203.0.113.2' });
    assert.equal(first.status, 303); assert.equal(second.status, 303);
    assert.notEqual(id(first), id(second));
    // Keep both connections open: each stream must stay attached to the
    // visitor selected by its own cookie, including on a declared page host.
    for (const [started, origin, cookie] of [[first, ORIGIN, cookieHeader(first)],
      [second, SECONDARY, demoCookie(second).split(';')[0]]]) {
      const response = await upgrade(origin + '/api/live?channel=notes', cookie);
      assert.equal(response.status, 101);
      assert.ok(response.webSocket, 'the app Upgrade response retains its live socket');
      response.webSocket.accept(); sockets.push(response.webSocket);
      assert.deepEqual(await exchange(response.webSocket, 'hello'), { id: id(started), url: 'http://container/api/live?channel=notes',
        origin, cookie, payload: 'hello' });
    }
    assert.equal((await exchange(sockets[0], 'first again')).id, id(first));

    const namespace = await mf.getDurableObjectNamespace('DEMO');
    const capacity = await mf.getDurableObjectNamespace('CAPACITY');
    const before = [...demos.values()].map(demo => demo.requests.length);
    // An owner session alone cannot select a demo. Neither malformed nor
    // foreign-namespace demo IDs may borrow another visitor's owner session.
    for (const cookie of [undefined, `__Host-operator_session=${id(first)}`, 'rer_demo=forged',
      `rer_demo=${capacity.newUniqueId()}; __Host-operator_session=${id(first)}`]) {
      const response = await upgrade('/api/live', cookie);
      assert.equal(response.status, 303);
      assert.equal(response.webSocket, null);
      await response.body?.cancel();
    }
    const unstarted = await upgrade('/api/live', `rer_demo=${namespace.newUniqueId()}`);
    assert.equal(unstarted.status, 410);
    assert.equal(unstarted.webSocket, null);
    await unstarted.body?.cancel();
    const foreignHost = await upgrade('https://unlisted.demo.run-test.example/api/live', cookieHeader(first));
    assert.equal(foreignHost.status, 404);
    assert.equal(foreignHost.webSocket, null);
    await foreignHost.body?.cancel();
    assert.deepEqual([...demos.values()].map(demo => demo.requests.length), before);

    const visit = () => upgrade('/api/live', cookieHeader(first));
    // Requests enforce expiry even if the platform alarm has not arrived.
    await namespace.get(namespace.idFromString(id(first))).advance(15 * 60_000 + 1);
    const ended = await visit();
    assert.equal(ended.status, 410);
    assert.equal(ended.webSocket, null);
    assert.ok(ended.headers.getSetCookie().some(value => value.startsWith('rer_demo=;') && value.includes('Max-Age=0')));
    await ended.body?.cancel();
    const stillEnded = await visit();
    assert.equal(stillEnded.status, 410); await stillEnded.body?.cancel();
    assert.deepEqual([...demos.values()].map(demo => demo.requests.length), before);
    assert.equal((await exchange(sockets[1], 'second remains')).id, id(second));
  } finally {
    for (const socket of sockets) socket.close(1000, 'test complete');
    await mf.dispose();
  }
});
