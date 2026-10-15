import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operatorMail } from '../../src/core/platform/auth/mail.server.mjs'
import { localDevelopmentEnabled } from '../../src/core/platform/auth/local.server.mjs'

// These are app sends through the configured facade, including accidental live settings.
test('local development and demo suppress application mail before provider or D1 access', async () => {
  const message = { deliveryId: 'security-check', from: 'sender@example.test', to: ['reader@example.test'], subject: 'Hello', text: 'Body' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => assert.fail('development or demo contacted a provider')
  try {
    for (const settings of [
      { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787' },
      { AUTH_ORIGIN: 'https://demo.example.test', RER_DEMO: '1' },
    ]) {
      const result = await operatorMail({ ...settings, MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-only-key', DB: { prepare() { assert.fail('mail was captured') } } }).send(message)
      assert.deepEqual(result, { provider: 'development', status: 'development', providerMessageId: null })
    }
    assert.equal(operatorMail({ AUTH_LOCAL: 'true', AUTH_ORIGIN: 'https://public.example.test', MAIL_PROVIDER: 'development' }), undefined)
  } finally { globalThis.fetch = originalFetch }
})

test('local capability accepts only explicit exact loopback configuration', () => {
  for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'https://localhost']) {
    assert.equal(localDevelopmentEnabled({ AUTH_LOCAL: 'true', AUTH_ORIGIN: origin }), true)
  }
})
