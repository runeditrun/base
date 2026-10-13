import type { Hono } from 'hono'
import { z } from 'zod'
import { planD1Import, createD1ImportJob, readD1ImportJob, resumeD1Import, undoD1Import, readD1ErasureJournal } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { Session } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../platform/bindings.server'
import { peopleImportContext, peopleMapping, peopleSource } from './imports.server'

type Environment = { Bindings: Bindings; Variables: { session: Session; files: R2Bucket } }
const importInput = z.object({
  label: z.string().trim().min(1).max(200),
  people: z.array(z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().trim().min(1).max(200), email: z.string().email().max(320), details: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(500),
}).strict()
const resumeInput = z.object({ batches: z.number().int().min(1).max(500).optional() }).strict()

/** A retired import answers 410 with the erasure journal receipt that retired it. */
function kitFailure(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  if (code === 'IMPORT_JOB_RETIRED') return Response.json({ error: 'import_retired', receiptId: (error as Error & { receiptId: string }).receiptId }, { status: 410 })
  if (code === 'IMPORT_JOB_NOT_FOUND' || code === 'JOB_BINDING_MISMATCH') return Response.json({ error: 'not found' }, { status: 404 })
  if (/^(IMPORT_|TARGET_|NATIVE_|OPERATION_KEY_)/.test(code)) return Response.json({ error: code.toLowerCase() }, { status: 409 })
  throw error
}

/** People imports and the import-custody erasure journal. The label is the
 * import's operation key: the same label imports once. */
export function importRoutes(app: Hono<Environment>) {
  const context = (c: { env: Bindings; get(key: 'session'): Session }, extra = {}) => peopleImportContext(c.env.DB, c.get('session').operator, extra)
  app.post('/api/people/imports', async (c) => {
    const parsed = importInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_import' }, 400)
    try {
      const plan = await planD1Import(peopleSource(parsed.data.people), peopleMapping, context(c))
      const job = await createD1ImportJob(plan, context(c, { operationKey: parsed.data.label, reviewedFingerprint: plan.fingerprint }))
      return c.json({ job }, 201)
    } catch (error) { return kitFailure(error) }
  })
  app.get('/api/people/imports/:id', async (c) => {
    try { return c.json({ job: await readD1ImportJob(c.req.param('id'), context(c)) }) } catch (error) { return kitFailure(error) }
  })
  app.post('/api/people/imports/:id/resume', async (c) => {
    const parsed = resumeInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid_resume' }, 400)
    try { return c.json({ job: await resumeD1Import(c.req.param('id'), context(c, parsed.data.batches ? { maxBatches: parsed.data.batches } : {})) }) } catch (error) { return kitFailure(error) }
  })
  app.post('/api/people/imports/:id/undo', async (c) => {
    try { return c.json({ job: await undoD1Import(c.req.param('id'), context(c)) }) } catch (error) { return kitFailure(error) }
  })
  app.get('/api/erasures/journal', async (c) => c.json({ journal: await readD1ErasureJournal(context(c)) }))
}
