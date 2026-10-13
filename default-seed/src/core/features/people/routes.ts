import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ErasureError, toD1Sql } from '../../../../../modules/erasure/index.mjs'
import type { Session } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { operatorMail } from '../../platform/auth/mail.server.mjs'
import { newUlid } from '../../platform/identifiers.server'
import { custodyCheckpoint, peopleErasure } from './erasure'
import { importRoutes } from './import-routes'
import { readD1ImportFieldMatches, retireD1ImportCustody } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { D1CustodyRetirement, D1ImportContext } from '../../../../../modules/import-kit/src/d1/index.ts'
import { peopleImportContext, PERSON } from './imports.server'
import { addNote, attachFile, createPerson, erasureRequestedStatement, exportPerson, personExists } from './repository.server'

type Environment = { Bindings: Bindings; Variables: { session: Session; files: R2Bucket } }
const personInput = z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().max(320), details: z.record(z.string(), z.unknown()).default({}) }).strict()
const noteInput = z.object({ body: z.string().trim().min(1).max(10_000) }).strict()
const erasureInput = z.object({ confirmation: z.string().max(200) }).strict()
const MAX_FILE_BYTES = 10 * 1024 * 1024
// A queued continuation picks up whatever one request could not finish.
const REQUEST_BUDGET_MS = 20_000

/** Same-origin, signed-in owners and admins only: members get 403. */
export const operatorOnly: MiddlewareHandler<Environment> = async (context, next) => {
  context.header('cache-control', 'no-store')
  const request = context.req.raw
  if (!['GET', 'HEAD'].includes(request.method) &&
      (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site')) {
    return context.json({ error: 'origin rejected' }, 403)
  }
  const session = await sessionForRequest(context.env, request)
  if (!session) return context.json({ error: 'authentication required' }, 401)
  if (!['owner', 'admin'].includes(session.operator.role)) return context.json({ error: 'operator role required' }, 403)
  if (!context.env.FILES) return context.json({ error: 'missing_binding:FILES' }, 503)
  context.set('session', session)
  context.set('files', context.env.FILES)
  await next()
}

// The import erasure journal row, without the native statement results.
const journalEntry = ({ nativeResults: _, ...entry }: D1CustodyRetirement) => entry
const failed = (error: unknown) => error instanceof ErasureError
  ? Response.json({ error: error.code }, { status: error.status })
  : null

/** In this custody transaction the request audit retires the subject from the
 * import target set. Its native rows stay for the bounded erasure that follows.
 * Both the exact live row and the retirement marker are fenced by the adapter. */
function retiringPeopleContext(context: D1ImportContext, subject: string): D1ImportContext {
  const targets = context.storage.targets
  const retired = "EXISTS(SELECT 1 FROM audit_events WHERE entity_type='person' AND entity_id=? AND action='person.erasure_requested')"
  const isRetired = async (db: D1ImportContext['storage']['database']) => Boolean(await db.prepare(`SELECT 1 WHERE ${retired}`).bind(subject).first())
  return { ...context, storage: { ...context.storage, targets: {
    ...targets,
    async read(db, destination, kind, id) {
      if (kind === PERSON && id === subject && await isRetired(db)) return undefined
      return targets.read(db, destination, kind, id)
    },
    matches(row, destination, kind, id) {
      const match = targets.matches(row, destination, kind, id)
      if (kind !== PERSON || id !== subject) return match
      return { sql: `(${match.sql}) ${row ? 'AND NOT' : 'OR'} (${retired})`, params: [...match.params ?? [], subject] }
    },
    matchesCount(count) {
      return { sql: `(SELECT count(*) FROM people WHERE import_revision IS NOT NULL AND NOT(id=? AND ${retired}))=?`, params: [subject, subject, count] }
    },
    async list(db, destination) {
      const rows = await targets.list(db, destination)
      return await isRetired(db) ? rows.filter(row => row.targetKind !== PERSON || row.targetId !== subject) : rows
    },
  } } }
}

export async function continueErasure(bindings: Bindings, id: string) {
  if (!bindings.FILES) throw new Error('Missing Worker binding: FILES')
  const erasure = await peopleErasure(bindings.DB, bindings.FILES)
  const receipt = await erasure.run(id, { until: Date.now() + REQUEST_BUDGET_MS })
  if (receipt.phase !== 'complete') await bindings.JOBS.send({ erasure: id })
  return receipt
}

/** The cron sweep: an erasure whose queue message was lost still finishes. */
export async function resumePendingErasures(bindings: Bindings) {
  if (!bindings.FILES) return
  const pending = (await bindings.DB.prepare("SELECT id FROM rer_erasure_operations WHERE phase<>'complete' ORDER BY requested_at LIMIT 5").all<{ id: string }>()).results
  for (const { id } of pending) {
    try { await continueErasure(bindings, id) }
    catch (error) { if (!(error instanceof ErasureError && error.code === 'erasure_busy')) throw error }
  }
}

export function peopleRoutes() {
  const app = new Hono<Environment>()
  // Guard the whole namespaces before route matching, including unknown members.
  for (const path of ['/api/people', '/api/people/*', '/api/erasures/*']) app.use(path, operatorOnly)
  app.onError((error, context) => failed(error) ?? context.json({ error: 'service_unavailable' }, 503))
  importRoutes(app)
  app.post('/api/people', async (context) => {
    const parsed = personInput.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_person' }, 400)
    const id = await createPerson(context.env.DB, context.get('session').operatorId, parsed.data)
    const mail = context.env.MAIL_FROM ? operatorMail(context.env) : undefined
    if (mail) await mail.send({ deliveryId: newUlid(), from: context.env.MAIL_FROM!, to: [parsed.data.email], subject: 'You were added',
      text: `Hello ${parsed.data.name}, an operator added you to this workspace.`, html: '', headers: {} })
    return context.json({ id }, 201)
  })
  app.post('/api/people/:id/notes', async (context) => {
    const id = context.req.param('id')
    if (!await personExists(context.env.DB, id)) return context.json({ error: 'not found' }, 404)
    const parsed = noteInput.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_note' }, 400)
    return context.json({ id: await addNote(context.env.DB, context.get('session').operatorId, id, parsed.data.body) }, 201)
  })
  app.post('/api/people/:id/files', async (context) => {
    const id = context.req.param('id')
    if (!await personExists(context.env.DB, id)) return context.json({ error: 'not found' }, 404)
    const form = await context.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return context.json({ error: 'invalid_file' }, 400)
    const name = file.name.trim()
    const bytes = await file.arrayBuffer()
    if (!name || name.length > 255 || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) return context.json({ error: 'invalid_file' }, 400)
    const contentType = file.type || 'application/octet-stream'
    return context.json({ id: await attachFile(context.env.DB, context.get('files'), context.get('session').operatorId, id, { name, contentType, bytes }) }, 201)
  })
  app.get('/api/people/:id/export', async (context) => {
    const data = await exportPerson(context.env.DB, context.get('files'), context.req.param('id'))
    if (!data) return context.json({ error: 'not found' }, 404)
    context.header('content-disposition', 'attachment; filename="person-export.json"')
    return context.json(data)
  })
  app.get('/api/people/:id/erasure', async (context) => {
    const erasure = await peopleErasure(context.env.DB, context.get('files'))
    return context.json(await erasure.preview('person', { id: context.req.param('id') }))
  })
  // Typed confirmation: the operator types `erase <id>` exactly.
  app.post('/api/people/:id/erasure', async (context) => {
    const id = context.req.param('id')
    if (!await personExists(context.env.DB, id)) return context.json({ error: 'not found' }, 404)
    const parsed = erasureInput.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success || parsed.data.confirmation !== `erase ${id}`) return context.json({ error: 'confirmation_mismatch', expected: 'erase <id>' }, 400)
    const db = context.env.DB, files = context.get('files'), operatorId = context.get('session').operatorId
    const erasure = await peopleErasure(db, files)
    const person = (await db.prepare('SELECT email,details FROM people WHERE id=?').bind(id).first<{ email: string; details: string }>())!
    // Import custody, by exact identifiers only: their records become tombstones,
    // and an import labelled with exactly their email is retired whole. A name is
    // not an identifier, so an import labelled "Alice" is not touched.
    const sourceUserId = JSON.parse(person.details).sourceUserId
    const references = [...new Set([id, ...(typeof sourceUserId === 'string' && sourceUserId.length ? [sourceUserId] : [])])]
    const imports = retiringPeopleContext(peopleImportContext(db, context.get('session').operator), id)
    const fields = references.map(value => ({ path: ['details', 'reactions', '*', 'users', '*'], value }))
    const selection = await readD1ImportFieldMatches(fields, imports)
    const custody = { target: { kind: PERSON, id }, values: [person.email],
      related: { fields: selection.fieldMatches.some(field => field.matches > 0) ? fields : [], snapshot: selection.snapshot } }
    // Native-created people can also be named in imported peers. Retirement,
    // reference redaction, custody and the restore checkpoint commit together;
    // native deletion then runs in bounded, resumable steps.
    const journal = journalEntry(await retireD1ImportCustody(custody,
      [toD1Sql(erasureRequestedStatement(db, operatorId, id))], imports, await custodyCheckpoint(db, files, true)))
    const opened = await erasure.start('person', { id })
    const receipt = await continueErasure(context.env, opened.id)
    return context.json({ receipt, journal }, receipt.phase === 'complete' ? 200 : 202)
  })
  app.get('/api/erasures/:id', async (context) => {
    const erasure = await peopleErasure(context.env.DB, context.get('files'))
    return context.json({ receipt: await erasure.receipt(context.req.param('id')) })
  })
  app.post('/api/erasures/:id/resume', async (context) => {
    const receipt = await continueErasure(context.env, context.req.param('id'))
    return context.json({ receipt }, receipt.phase === 'complete' ? 200 : 202)
  })
  return app
}
