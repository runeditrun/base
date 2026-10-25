import { createJobHandler, d1Database, JobError } from '../../../../../modules/durable-jobs/index.ts'
import { validSalesOrigin } from './auth-origin.server.mjs'
import { sessionForRequest } from '../../platform/auth/session.server'
import { authConfig } from '../../platform/auth/config.server'
import type { Bindings } from '../../platform/bindings.server'
import { referenceSalesAuthority } from './authority.server.ts'
import { createReferenceSalesJobs } from './runtime.server.ts'

export function referenceSalesEnabled(env: Pick<Bindings, 'DURABLE_JOBS_REFERENCE' | 'RER_INSTALLATION_ID'>) {
  return env.DURABLE_JOBS_REFERENCE === 'true' && typeof env.RER_INSTALLATION_ID === 'string' && env.RER_INSTALLATION_ID.length > 0
}

export async function durableJobsResponse(request: Request, env: Bindings): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/rer/jobs' && !path.startsWith('/api/rer/jobs/')) return null
  if (!referenceSalesEnabled(env)) return Response.json({ error: 'durable_jobs_not_configured' }, { status: 404, headers: { 'cache-control': 'no-store' } })
  const database = d1Database(env.DB)
  const jobs = createReferenceSalesJobs({ database, installationId: env.RER_INSTALLATION_ID!, scheduler: 'native' })
  return createJobHandler(jobs, async (req: Request, mutation: boolean) => {
    if (!validSalesOrigin(req, authConfig(env), mutation)) return null
    const session = await sessionForRequest(env, req)
    if (!session) return null
    const tenant = req.headers.get('x-rer-sales-tenant')
    const authority = await referenceSalesAuthority(database, env.RER_INSTALLATION_ID!, session.operatorId, tenant)
    if (!authority) throw new JobError('job_not_found', 404)
    return authority
  })(request)
}

/** A scheduled event is only a bounded wake-up; it conveys no user authority. */
export async function tickReferenceSales(env: Bindings) {
  if (!referenceSalesEnabled(env)) return
  const jobs = createReferenceSalesJobs({ database: d1Database(env.DB), installationId: env.RER_INSTALLATION_ID!, scheduler: 'native' })
  await jobs.tick({ maxJobs: 5, deadline: Date.now() + 15_000 })
}
