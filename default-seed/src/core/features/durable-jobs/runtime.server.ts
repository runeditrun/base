import { createDurableJobs } from '../../../../../modules/durable-jobs/index.ts'
import type { Database, Limits } from '../../../../../modules/durable-jobs/src/types.ts'
import { createSalesKind } from './sales.server.ts'
import { createSalesPolicy } from './policy.server.ts'

export interface ReferenceSalesOptions {
  database: Database
  installationId: string
  scheduler: 'native' | 'manual'
  limits?: Partial<Limits>
  now?: () => number
}

/** No application data is fabricated. Enabling this registration only makes
 * previously ingested, explicitly authorized source revisions executable. */
export function createReferenceSalesJobs(options: ReferenceSalesOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(options.installationId)) throw new Error('durable_jobs_installation_required')
  return createDurableJobs({ ...options,
    kinds: [createSalesKind(options.database)],
    policy: createSalesPolicy(options.database, options.installationId),
  })
}
