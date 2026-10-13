import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

// Start imports this wrapper into route modules. Keep protected implementation
// imports inside handlers so the client receives only generated RPC stubs.
export const loadPublicArticles = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ readPublicArticles }, { requestBindings }] = await Promise.all([
    import('../features/reference/service'),
    import('../platform/bindings.server'),
  ])
  return readPublicArticles(requestBindings())
})

export const requireOperator = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ sessionForStartRequest }, { requestBindings }] = await Promise.all([
    import('../platform/auth/start-session.server'),
    import('../platform/bindings.server'),
  ])
  const session = await sessionForStartRequest(requestBindings())
  // The sign-in page is server-rendered, outside the route tree: a document navigation.
  if (!session) throw redirect({ href: '/signin?returnTo=%2Fapp', reloadDocument: true })
  const { needsFirstRun } = await import('../../../../foundation/runtime/setup')
  if (await needsFirstRun(requestBindings(), session)) throw redirect({ href: '/setup', reloadDocument: true })
  return session
})

export const loadPrivateDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ sessionForStartRequest }, { readDashboard }, { requestBindings }] = await Promise.all([
    import('../platform/auth/start-session.server'),
    import('../features/reference/service'),
    import('../platform/bindings.server'),
  ])
  const bindings = requestBindings()
  const session = await sessionForStartRequest(bindings)
  if (!session) throw redirect({ href: '/signin?returnTo=%2Fapp', reloadDocument: true })
  const { needsFirstRun } = await import('../../../../foundation/runtime/setup')
  if (await needsFirstRun(bindings, session)) throw redirect({ href: '/setup', reloadDocument: true })
  return readDashboard(bindings)
})
