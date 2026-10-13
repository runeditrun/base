import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signinPresentation } from '../../src/core/platform/auth/signin-options.server.mjs'

const localInstructions = 'Open .dev.vars in your local project and copy the SETUP_TOKEN value. This signs in the configured owner without sending email.'
const deploymentInstructions = 'Use the setup token from your deployment. This signs in the configured owner without sending email.'

const configurations = [
  ['IPv4 loopback', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787' }, true],
  ['localhost', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://localhost:8787' }, true],
  ['IPv6 loopback', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://[::1]:8787' }, true],
  ['HTTPS loopback', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'https://localhost' }, true],
  ['local disabled', { AUTH_LOCAL: 'false', AUTH_ORIGIN: 'http://127.0.0.1:8787' }, false],
  ['local unset', { AUTH_ORIGIN: 'http://127.0.0.1:8787' }, false],
  ['local wrong case', { AUTH_LOCAL: 'TRUE', AUTH_ORIGIN: 'http://127.0.0.1:8787' }, false],
  ['local boolean', { AUTH_LOCAL: true, AUTH_ORIGIN: 'http://127.0.0.1:8787' }, false],
  ['origin unset', { AUTH_LOCAL: 'true' }, false],
  ['malformed origin', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'invalid origin' }, false],
  ['foreign origin', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'https://app.example.test' }, false],
  ['lookalike origin', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1.example.test' }, false],
  ['origin with credentials', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://name@127.0.0.1:8787' }, false],
  ['origin with trailing slash', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787/' }, false],
  ['origin with path', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787/signin' }, false],
  ['origin with query', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787?local=true' }, false],
  ['origin with fragment', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8787#local' }, false],
  ['unsupported protocol', { AUTH_LOCAL: 'true', AUTH_ORIGIN: 'ftp://localhost' }, false],
]

for (const [provider, enabled] of [
  ['development', true],
  ['resend', false],
  ['sendgrid', false],
  ['cloudflare', false],
  [undefined, false],
  ['', false],
  ['Development', false],
  ['development ', false],
]) {
  test(`sign-in presentation with ${provider === undefined ? 'unset' : JSON.stringify(provider)} mail provider`, () => {
    for (const [name, bindings, local] of configurations) {
      const options = signinPresentation({ ...bindings, MAIL_PROVIDER: provider })
      assert.deepEqual(options, {
        local,
        developmentOutbox: enabled && local,
        setupInstructions: local ? localInstructions : deploymentInstructions,
      }, name)
    }
  })
}
