import { Hono } from 'hono'
import { AuthError } from '../../modules/operator-auth/index.mjs'
import type { Bindings } from '../platform/bindings.server'
import { deploymentHealth } from '../../base/deployment-health'
import { sessionForRequest } from '../platform/auth/session.server'
import { checkHealth, queueReferenceJob, readJob, readPublicArticles, readDashboard } from '../features/reference/service'

type Environment = { Bindings: Bindings }
let people: Promise<Hono<any>> | undefined
const peopleApp = () => (people ??= import('../features/people/routes').then((feature) => feature.peopleRoutes()))

export function createApi() {
  const app = new Hono<Environment>()
  app.onError((error, context) => {
    if (error instanceof AuthError) return context.json({ error: error.code }, error.status as 403)
    return context.json({ error: 'service_unavailable' }, 503)
  })
  app.use('/api/*', async (context, next) => {
    context.header('x-reference-dispatch', 'hono')
    await next()
  })
  app.get('/health', async (context) => {
    await checkHealth(context.env)
    context.header('x-reference-dispatch', 'hono')
    return context.json({ status: 'ok', ...deploymentHealth(context.env) })
  })
  app.get('/api/public/feed', async (context) => {
    return context.json({ articles: await readPublicArticles(context.env) })
  })
  // Guard the entire private namespace before route matching, including unknown
  // members. Every call uses the same persisted admission as Start and /auth.
  app.use('/api/work', privateWork)
  app.use('/api/work/*', privateWork)
  app.post('/api/work', async (context) => context.json(await queueReferenceJob(context.env), 202))
  app.get('/api/work/:id', async (context) => {
    const job = await readJob(context.env, context.req.param('id'))
    return job ? context.json(job) : context.json({ error: 'not found' }, 404)
  })
  app.get('/api/work', async (context) => context.json(await readDashboard(context.env)))
  // The erasure example (and portability with it) loads on first use, outside the eager graph.
  for (const path of ['/api/people', '/api/people/*', '/api/erasures/*']) {
    app.all(path, async (context) => (await peopleApp()).fetch(context.req.raw, context.env, context.executionCtx))
  }
  return app
}

import type { MiddlewareHandler } from 'hono'
const privateWork: MiddlewareHandler<Environment> = async (context, next) => {
  context.header('cache-control', 'no-store')
  const request = context.req.raw
  if (!['GET', 'HEAD'].includes(request.method) &&
      (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site')) {
    return context.json({ error: 'origin rejected' }, 403)
  }
  if (!await sessionForRequest(context.env, request)) return context.json({ error: 'authentication required' }, 401)
  await next()
}
