import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operatorMail } from '../../src/core/platform/auth/mail.server.mjs'
import { localDevelopmentEnabled } from '../../src/core/platform/auth/local.server.mjs'
import { developmentOutboxResponse } from '../../src/core/platform/auth/outbox.server.mjs'

async function assertPrivateRefusal(response) {
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  const directives = new Map(response.headers.get('content-security-policy')?.split(';').map(directive => {
    const [name, ...sources] = directive.trim().split(/\s+/)
    return [name, sources]
  }))
  for (const directive of ['default-src', 'script-src', 'style-src', 'base-uri', 'form-action', 'frame-ancestors', 'object-src']) {
    assert.deepEqual(directives.get(directive), ["'none'"], directive)
  }
  assert.equal(await response.text(), 'Not found')
}

test('development sender and viewer cannot be enabled by a production binding or public origin', async () => {
  const db = { prepare() { assert.fail('disabled local capabilities must not access D1') } }
  for (const settings of [
    { AUTH_ORIGIN: 'https://app.example.test' },
    { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'https://app.example.test' },
    { AUTH_LOCAL: 'false', AUTH_ORIGIN: 'http://127.0.0.1:8787' },
    { AUTH_LOCAL: 'TRUE', AUTH_ORIGIN: 'http://127.0.0.1:8787' },
    { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787/' },
    { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1.example.test' },
    { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://name@127.0.0.1:8787' },
  ]) {
    const env = { ...settings, DB: db, MAIL_PROVIDER: 'development' }
    assert.equal(localDevelopmentEnabled(env), false)
    assert.equal(operatorMail(env), undefined)
    const response = await developmentOutboxResponse(new Request('https://app.example.test/__dev/outbox'), env)
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    await assertPrivateRefusal(response)
  }
})

test('outbox rejects a missing or wrong key, forged request URL, Host, Origin and cross-site requests before storage', async () => {
  const origin = 'http://127.0.0.1:8787', key = 'k'.repeat(43)
  const env = { AUTH_LOCAL: 'true', AUTH_ORIGIN: origin, RER_DEV_KEY: key, DB: { prepare() { assert.fail('forged authority reached D1') } } }
  for (const [url, headers] of [
    // A forwarding proxy rewrites Host to loopback: only the key separates it.
    [`${origin}/__dev/outbox`, { host: '127.0.0.1:8787' }],
    [`${origin}/__dev/outbox`, { host: '127.0.0.1:8787', 'x-rer-dev-key': 'w'.repeat(43) }],
    [`${origin}/__dev/outbox`, { host: '127.0.0.1:8787', cookie: 'rer_dev_gate_8787=forged' }],
  ]) {
    const response = await developmentOutboxResponse(new Request(url, { headers }), env)
    await assertPrivateRefusal(response)
  }
  for (const [url, headers] of [
    ['http://elsewhere.example.test/__dev/outbox', { host: 'elsewhere.example.test' }],
    [`${origin}/__dev/outbox`, {}],
    [`${origin}/__dev/outbox`, { host: 'elsewhere.example.test' }],
    [`${origin}/__dev/outbox`, { host: 'elsewhere.example.test', 'x-forwarded-host': '127.0.0.1:8787', 'x-forwarded-proto': 'http' }],
    [`${origin}/__dev/outbox`, { host: '127.0.0.1:8787', origin: 'https://elsewhere.example.test' }],
    [`${origin}/__dev/outbox`, { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }],
  ]) {
    const response = await developmentOutboxResponse(new Request(url, { headers: { ...headers, 'x-rer-dev-key': key } }), env)
    assert.ok([403, 404].includes(response.status))
    await assertPrivateRefusal(response)
  }
})

test('outbox leaves unrelated routes to the application before inspecting configuration or storage', async () => {
  const env = new Proxy({}, { get() { assert.fail('unrelated routes must not inspect outbox bindings') } })
  for (const pathname of ['/', '/signin', '/__dev/outbox/']) {
    assert.equal(await developmentOutboxResponse(new Request(`http://127.0.0.1:8787${pathname}`), env), null)
  }
})

test('local capability accepts only explicit exact loopback configuration', () => {
  for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'https://localhost']) {
    assert.equal(localDevelopmentEnabled({ AUTH_LOCAL: 'true', AUTH_ORIGIN: origin }), true)
  }
})
