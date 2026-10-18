import { withDemo } from '../../modules/demo/index.mjs'
import { dependenciesResponse } from './core/platform/auth/dependencies.server'
import { firstRunResponse } from '../../foundation/runtime/setup'
import { operatorAuth } from './core/platform/auth/session.server'
import { z } from 'zod'
import { authResponse, signInResponse } from './core/app/auth-http.server'
import { createApi } from './core/app/hono'
import { uncachedStartResponse } from './core/app/start-response.server'
import { completeReferenceJob, recordScheduledRun } from './core/features/reference/service'
import { requireBindings, type Bindings } from './core/platform/bindings.server'
import { developmentKeyResponse } from './core/platform/auth/key.server.mjs'
import { theme } from './core/app/theme'
import { identity } from './core/app/identity'
import { lobbyResponse } from '../../foundation/runtime/lobby'
import { setupStateResponse } from '../../foundation/runtime/setup-state'

import { dispatch } from '../../foundation/runtime/dispatch'
import { staticAssetResponse } from '../../foundation/runtime/static-assets'
import { seedDemo } from './demo'
import { importDoorResponse } from './core/features/people/door.server'
import { importPageResponse } from './core/features/people/import-page.server'
import { rejectedResponse } from '../../foundation/runtime/rejected-response'

const api = createApi()
const queueMessage = z.union([z.object({ id: z.string().length(26) }).strict(), z.object({ erasure: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  z.object({ redact: z.string().min(1).max(200), chain: z.string().length(26) }).strict()])

export default withDemo({
  async fetch(request, bindings: Bindings, execution): Promise<Response> {
    const asset = await staticAssetResponse(request, bindings)
    if (asset) return asset
    bindings = requireBindings(bindings)
    const imported = await importDoorResponse(request, bindings)
    // Admission runs before dispatch, so finish refused uploads with the same
    // bounded drain as the normal router. Otherwise workerd can replace 4xx
    // replies with an upload-proxy 500 when the request body is still unread.
    if (imported) return rejectedResponse(request, imported)
    const keyExchange = await developmentKeyResponse(request, bindings)
    if (keyExchange) return keyExchange
    if (new URL(request.url).pathname.startsWith('/.well-known/rer-') || new URL(request.url).pathname.startsWith('/auth/dependencies/') || new URL(request.url).pathname === '/auth/owner-claim') {
      const linked = await dependenciesResponse(request, bindings)
      if (linked) return linked
    }
    const waitUntil = (promise: Promise<unknown>) => execution.waitUntil(promise)
    if (new URL(request.url).pathname.startsWith('/auth/')) return authResponse(request, requireBindings(bindings), waitUntil)
    const path = new URL(request.url).pathname
    // The installed variant: the Lobby at / and the public claim state it reads.
    const state = await setupStateResponse(request, bindings)
    if (state) return state
    const lobby = await lobbyResponse(request, bindings, identity)
    if (lobby) return lobby
    if (path === '/signin') {
      const page = await signInResponse(request, bindings, waitUntil)
      if (page) return page
    }
    if (path === '/setup' || path === '/app' || path.startsWith('/app/')) {
      const setup = await firstRunResponse(request, bindings, operatorAuth(bindings), { theme })
      if (setup) return setup
    }
    if (path === '/app/import') {
      const imports = await importPageResponse(request, bindings)
      if (imports) return imports
    }
    if (path === '/app/people') {
      const people = await (await import('./core/features/people/page.server')).peoplePageResponse(request, bindings)
      if (people) return people
    }
    return dispatch(request, () => api.fetch(request, requireBindings(bindings), execution), async () => {
      const url = new URL(request.url)
      if (bindings.AUTH_ORIGIN && (url.origin !== bindings.AUTH_ORIGIN || (request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== new URL(bindings.AUTH_ORIGIN).host.toLowerCase()))) return new Response('Not found', { status: 404 })
      // Initialize the document renderer only after HTTP routing and origin admission.
      const { default: start } = await import('@tanstack/react-start/server-entry')
      return uncachedStartResponse(await start.fetch(request))
    })
  },
  async queue(batch, bindings: Bindings): Promise<void> {
    const checkedBindings = requireBindings(bindings)
    for (const message of batch.messages) {
      const parsed = queueMessage.safeParse(message.body)
      if (!parsed.success) throw new Error('Queue message does not match reference.lifecycle.v1 or an erasure continuation')
      if ('erasure' in parsed.data) await (await import('./core/features/people/routes')).continueErasure(checkedBindings, parsed.data.erasure)
      else if ('redact' in parsed.data) await (await import('./core/features/people/routes')).continueRedaction(checkedBindings, parsed.data.redact, parsed.data.chain)
      else await completeReferenceJob(checkedBindings, parsed.data.id)
      message.ack()
    }
  },
  async scheduled(controller, bindings: Bindings): Promise<void> {
    const checked = requireBindings(bindings)
    await recordScheduledRun(checked, controller.cron)
    await (await import('./core/features/people/routes')).resumePendingErasures(checked)
  },
} satisfies ExportedHandler<Bindings>, { seed: seedDemo })
