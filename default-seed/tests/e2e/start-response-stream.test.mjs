import { runRows } from '../rows.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uncachedStartResponse } from '../../src/core/app/start-response.server.ts'

const responseRows = []

responseRows.push(['Start response boundary preserves lazy stream identity, headers, status and cancellation', {}, async () => {
  let controller, cancelled
  const body = new ReadableStream({
    start(value) { controller = value },
    cancel(reason) { cancelled = reason },
  }, { highWaterMark: 0 })
  const original = new Response(body, {
    status: 202, statusText: 'Accepted',
    headers: { 'cache-control': 'public, max-age=600', 'content-type': 'application/x-tss-framed', 'x-tss-serialized': 'true' },
  })
  const response = uncachedStartResponse(original)
  assert.equal(response.body, original.body)
  assert.equal(response.bodyUsed, false)
  assert.equal(response.status, 202)
  assert.equal(response.statusText, 'Accepted')
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
  assert.equal(original.headers.get('cache-control'), 'public, max-age=600')
  assert.equal(response.headers.get('content-type'), 'application/x-tss-framed')
  assert.equal(response.headers.get('x-tss-serialized'), 'true')
  const reader = response.body.getReader()
  const next = reader.read()
  const chunk = new TextEncoder().encode('first native frame')
  controller.enqueue(chunk)
  assert.deepEqual(await next, { done: false, value: chunk })
  await reader.cancel('client disconnected')
  assert.equal(cancelled, 'client disconnected')
}])

responseRows.push(['Start response boundary preserves native empty redirects and cookie headers', {}, () => {
  const headers = new Headers({ location: '/signin?returnTo=%2Fapp' })
  headers.append('set-cookie', 'first=test; HttpOnly')
  headers.append('set-cookie', 'second=test; HttpOnly')
  const response = uncachedStartResponse(new Response(null, { status: 307, headers }))
  assert.equal(response.status, 307)
  assert.equal(response.body, null)
  assert.equal(response.headers.get('location'), '/signin?returnTo=%2Fapp')
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
  assert.deepEqual(response.headers.getSetCookie(), ['first=test; HttpOnly', 'second=test; HttpOnly'])
}])

test("Start response boundary preserves native streams, redirects and headers while refusing caching", async t => {
  await runRows(t, responseRows)
})
