import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createMailSender } from '../../mail/index.mjs'
import { sendSendGrid as sendLegacy, SendGridSendError } from '../src/sender.ts'
import { sendSendGrid as sendFromMail } from '../../mail/src/sendgrid-email/index.mjs'

// A fake SendGrid API: a local server that records exactly what arrives and answers
// with a scripted status. Each path's fetch is pointed at it; the real endpoint is
// asserted so only the host is substituted.
type Recorded = { method: string; url: string; headers: Record<string, string>; body: string }
async function fakeSendGrid() {
  const requests: Recorded[] = []
  let reply: { status: number; headers?: Record<string, string> } = { status: 202, headers: { 'x-message-id': 'fake-receipt' } }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const { host: _host, connection: _connection, ...headers } = request.headers as Record<string, string>
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(reply.status, reply.headers).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const fetch = (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send')
    return globalThis.fetch(`http://127.0.0.1:${address.port}/v3/mail/send`, init)
  }
  return {
    requests, fetch,
    respond(next: typeof reply) { reply = next },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

const base = { from: 'Support <support@example.com>', to: ['Ada <ada@example.net>', 'grace@example.net'], subject: 'Résumé ✓', text: 'Line one\nLine two ✓', html: '<p>Résumé</p>', deliveryId: 'durable-1' }
const bytes = Uint8Array.of(0, 255, 128, 10)
const base64 = 'AP+ACg=='
const cases = [
  ['minimal', { ...base, html: undefined }, { ...base, html: undefined }],
  ['text and html', base, base],
  ['threading, reply-to and provider settings', { ...base, replyTo: 'Replies <reply@example.com>', headers: { 'In-Reply-To': '<a@example.com>', References: '<r@example.com> <a@example.com>' }, asmGroupId: 33984, subscriptionTracking: true, customArgs: { rer_product: 'orbit' } },
    { ...base, replyTo: 'Replies <reply@example.com>', headers: { 'In-Reply-To': '<a@example.com>', References: '<r@example.com> <a@example.com>' }, asmGroupId: 33984, subscriptionTracking: true, customArgs: { rer_product: 'orbit' } }],
  ['attachment', { ...base, attachments: [{ content: base64, filename: 'bytes.bin', type: 'application/octet-stream' }] },
    { ...base, attachments: [{ content: bytes, filename: 'bytes.bin', contentType: 'application/octet-stream' }] }],
] as const

test('the former import path, the compat path and the facade send identical requests', async () => {
  const api = await fakeSendGrid()
  try {
    for (const [name, legacy, mail] of cases) {
      api.requests.length = 0
      const viaOldPath = await sendLegacy({ apiKey: 'fixture-key', message: legacy, fetch: api.fetch })
      const viaCompat = await sendFromMail({ apiKey: 'fixture-key', message: legacy, fetch: api.fetch })
      const viaFacade = await createMailSender({ provider: 'sendgrid', mode: 'production', apiKey: 'fixture-key' }, { fetch: api.fetch }).send(mail)
      assert.equal(api.requests.length, 3, name)
      assert.deepEqual(api.requests[1], api.requests[0], `${name}: compat path`)
      assert.deepEqual(api.requests[2], api.requests[0], `${name}: facade`)
      assert.equal(api.requests[0].method, 'POST')
      assert.equal(api.requests[0].url, '/v3/mail/send')
      assert.equal(api.requests[0].headers.authorization, 'Bearer fixture-key')
      assert.equal(api.requests[0].headers['content-type'], 'application/json')
      assert.deepEqual(viaOldPath, viaCompat)
      assert.deepEqual(viaOldPath, { provider: 'sendgrid', providerMessageId: 'fake-receipt', state: 'accepted' })
      assert.deepEqual(viaFacade, { provider: 'sendgrid', status: 'accepted', providerMessageId: 'fake-receipt' })
    }
  } finally { await api.close() }
})

test('every provider answer is classified the same on both import paths', async () => {
  const api = await fakeSendGrid()
  const outcomes: Record<number, string> = { 202: 'accepted', 400: 'rejected', 401: 'rejected', 429: 'rate_limited', 408: 'uncertain', 500: 'uncertain', 200: 'uncertain', 204: 'uncertain' }
  try {
    for (const [code, expected] of Object.entries(outcomes)) {
      api.respond({ status: Number(code), headers: Number(code) === 202 ? { 'x-message-id': 'id' } : {} })
      api.requests.length = 0
      const facade = await createMailSender({ provider: 'sendgrid', mode: 'production', apiKey: 'fixture-key' }, { fetch: api.fetch }).send(cases[1][2])
      assert.equal(facade.status, expected, code)
      const old = await sendLegacy({ apiKey: 'fixture-key', message: cases[1][1], fetch: api.fetch }).catch((error: unknown) => error)
      if (expected === 'accepted') assert.equal((old as { state: string }).state, 'accepted')
      else {
        assert.ok(old instanceof SendGridSendError, code)
        assert.equal(old.outcome, expected === 'uncertain' ? 'ambiguous' : expected, code)
        assert.equal(old.status, Number(code))
      }
      assert.equal(api.requests.length, 2, `one request per path for ${code}`)
      assert.deepEqual(api.requests[1], api.requests[0], `${code}: identical request`)
    }
  } finally { await api.close() }
})

test('the former serializer returns the exact body that is sent', async () => {
  const api = await fakeSendGrid()
  try {
    const { serializeSendGridMessage } = await import('../src/sender.ts')
    for (const [, legacy] of cases) {
      api.requests.length = 0
      await sendLegacy({ apiKey: 'fixture-key', message: legacy, fetch: api.fetch })
      assert.equal(api.requests[0].body, serializeSendGridMessage(legacy))
    }
  } finally { await api.close() }
})
