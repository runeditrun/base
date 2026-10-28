import { personRecordEvent } from '../../../agent-door/person-events.server'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ErasureError, toD1Sql } from '../../../../../modules/erasure/index.mjs'
import type { Session } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { operatorMail } from '../../platform/auth/mail.server.mjs'
import { newUlid } from '../../platform/identifiers.server'
import { custodyCheckpoint, peopleErasure } from './erasure'
import { journalRoutes } from './journal-routes'
import { retireD1ImportCustody } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { D1CustodyRetirement, D1ImportContext } from '../../../../../modules/import-kit/src/d1/index.ts'
import { peopleImportContext, PERSON, personSet } from './imports.server'
import { personRedaction } from './person-redaction.server'
import { CommandKeyError, commandKey, runOnce } from '../../../../../foundation/runtime/command-receipts'
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
    matchesMany: (rows) => personSet(rows, { sql: `NOT(id=? AND ${retired})`, params: [subject, subject] }),
    async list(db, destination) {
      const rows = await targets.list(db, destination)
      return await isRetired(db) ? rows.filter(row => row.targetKind !== PERSON || row.targetId !== subject) : rows
    },
    redaction: (db, _destination, fields) => personRedaction(db, fields, { sql: `NOT(id=? AND ${retired})`, params: [subject, subject] }),
  } } }
}

/** Erase a person. Import custody goes first, by exact identifiers only: their
 * records become tombstones, an import labelled with exactly their email is
 * retired whole, and their ids leave other people's reactions. A name is not an
 * identifier, so an import labelled "Alice" is not touched. When the reactions
 * span more imports than one request can rewrite, each request commits one
 * bounded step and queues the next. Then native deletion runs in bounded,
 * resumable steps.
 *
 * The request is recorded before the first step, with where the redaction
 * stands after each one (job ids and revisions, never a value), so a lost
 * request or queued step never strands it: the cron sweep takes it over. The
 * person's native erasure deletes that record. */
type ErasureOperator = { id: string; role: string; auditActor?: string }
export async function erasePerson(bindings: Bindings, operator: ErasureOperator, id: string) {
  const chain = newUlid()
  // Repeating the request takes the erasure over from where it stands.
  const pending = (await bindings.DB.prepare('INSERT INTO person_erasure_redactions(person_id,operator_id,chain,updated_at,audit_actor) VALUES(?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET operator_id=excluded.operator_id,chain=excluded.chain,updated_at=excluded.updated_at,audit_actor=excluded.audit_actor RETURNING continuation')
    .bind(id, operator.id, chain, new Date().toISOString(), operator.auditActor ?? null).first<{ continuation: string | null }>())!
  return eraseStep(bindings, operator, id, chain, pending.continuation)
}

/** One step of the erasure under the chain that owns it. */
async function eraseStep(bindings: Bindings, operator: ErasureOperator, id: string, chain: string, continuation: string | null) {
  if (!bindings.FILES) throw new Error('Missing Worker binding: FILES')
  const db = bindings.DB, files = bindings.FILES
  // Retiring import custody committed the request audit: only the native erasure remains.
  if (!await custodyRetired(db, id)) {
    const person = (await db.prepare('SELECT email,details FROM people WHERE id=?').bind(id).first<{ email: string; details: string }>())!
    const sourceUserId = JSON.parse(person.details).sourceUserId
    const references = [...new Set([id, ...(typeof sourceUserId === 'string' && sourceUserId.length ? [sourceUserId] : [])])]
    const imports = retiringPeopleContext(peopleImportContext(db, operator), id)
    // Optional: a person need not appear in anyone's reactions.
    const fields = references.map(value => ({ path: ['details', 'reactions', '*', 'users', '*'], value, optional: true }))
    // Native-created people can also be named in imported peers. Retirement,
    // reference redaction, custody and the restore checkpoint commit together.
    const result = await retireD1ImportCustody({ target: { kind: PERSON, id }, values: [person.email], related: { fields } },
      [toD1Sql(erasureRequestedStatement(db, operator.auditActor ?? operator.id, id))], imports, await custodyCheckpoint(db, files, true), { resumable: true, continuation: continuation ?? undefined })
    if (result.phase === 'redacting') {
      await db.prepare('UPDATE person_erasure_redactions SET continuation=?,updated_at=? WHERE person_id=? AND chain=?').bind(result.continuation, new Date().toISOString(), id, chain).run()
      await bindings.JOBS.send({ redact: id, chain })
      return { redaction: { jobsRedacted: result.jobsRedacted, jobsPending: result.jobsPending } }
    }
    const opened = await (await peopleErasure(db, files)).start('person', { id })
    return { receipt: await continueErasure(bindings, opened.id), journal: journalEntry(result) }
  }
  const opened = await (await peopleErasure(db, files)).start('person', { id })
  return { receipt: await continueErasure(bindings, opened.id) }
}

const custodyRetired = async (db: D1Database, id: string) =>
  Boolean(await db.prepare("SELECT 1 FROM audit_events WHERE entity_type='person' AND entity_id=? AND action='person.erasure_requested'").bind(id).first())

/** The queued next step of a person's erasure, under the operator who asked for
 * it (their role is checked again inside every step's batch). A step whose chain
 * a repeated request or the sweep took over, or whose erasure finished, stops. */
export async function continueRedaction(bindings: Bindings, id: string, chain: string) {
  const pending = await bindings.DB.prepare("SELECT r.continuation,r.audit_actor,o.id,o.role FROM person_erasure_redactions r JOIN oa_operators o ON o.id=r.operator_id AND o.status='active' WHERE r.person_id=? AND r.chain=?")
    .bind(id, chain).first<{ continuation: string | null; audit_actor: string | null; id: string; role: string }>()
  if (!pending || !await personExists(bindings.DB, id)) return
  await eraseStep(bindings, { id: pending.id, role: pending.role, auditActor: pending.audit_actor ?? undefined }, id, chain, pending.continuation)
}

export async function continueErasure(bindings: Bindings, id: string) {
  if (!bindings.FILES) throw new Error('Missing Worker binding: FILES')
  const erasure = await peopleErasure(bindings.DB, bindings.FILES)
  const receipt = await erasure.run(id, { until: Date.now() + REQUEST_BUDGET_MS })
  if (receipt.phase !== 'complete') await bindings.JOBS.send({ erasure: id })
  return receipt
}

/** The cron sweep: an erasure whose request or queue message was lost still finishes. */
export async function resumePendingErasures(bindings: Bindings) {
  if (!bindings.FILES) return
  // Still redacting import custody: take the erasure over under a new chain, so
  // a late message of the lost one stops. Custody already retired: make sure the
  // native erasure is open; the loop below runs it. A person an import's undo
  // removed meanwhile has nothing left to erase.
  await bindings.DB.prepare('DELETE FROM person_erasure_redactions WHERE person_id NOT IN (SELECT id FROM people)').run()
  const requested = (await bindings.DB.prepare('SELECT person_id AS id FROM person_erasure_redactions ORDER BY updated_at LIMIT 5').all<{ id: string }>()).results
  for (const { id } of requested) {
    if (await custodyRetired(bindings.DB, id)) { await (await peopleErasure(bindings.DB, bindings.FILES)).start('person', { id }); continue }
    const chain = newUlid()
    await bindings.DB.prepare('UPDATE person_erasure_redactions SET chain=?,updated_at=? WHERE person_id=?').bind(chain, new Date().toISOString(), id).run()
    await continueRedaction(bindings, id, chain)
  }
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
  journalRoutes(app)
  app.post('/api/people', async (context) => {
    const parsed = personInput.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_person' }, 400)
    const actor = context.get('session').operatorId
    const create = async () => {
      const id = await createPerson(context.env.DB, actor, parsed.data)
      await personRecordEvent(context.env, context.get('session').operator, 'person.created', id)
      const mail = context.env.MAIL_FROM ? operatorMail(context.env) : undefined
      if (mail) await mail.send({ deliveryId: newUlid(), from: context.env.MAIL_FROM!, to: [parsed.data.email], subject: 'You were added',
        text: `Hello ${parsed.data.name}, an operator added you to this workspace.`, html: '', headers: {} })
      return { result: { id } }
    }
    // An Idempotency-Key makes a retried create return the first person, not a second one.
    const key = context.req.header('idempotency-key')
    if (key === undefined) return context.json((await create()).result, 201)
    try { return context.json((await runOnce(context.env.DB, { actor, command: 'person.create', key: commandKey({ commandKey: key }) }, create)).result, 201) }
    catch (error) { if (error instanceof CommandKeyError) return context.json({ error: 'idempotency_key', message: error.message }, error.status); throw error }
  })
  app.post('/api/people/:id/notes', async (context) => {
    const id = context.req.param('id')
    if (!await personExists(context.env.DB, id)) return context.json({ error: 'not found' }, 404)
    const parsed = noteInput.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_note' }, 400)
    const note = await addNote(context.env.DB, context.get('session').operatorId, id, parsed.data.body)
    await personRecordEvent(context.env, context.get('session').operator, 'person.note.added', id)
    return context.json({ id: note }, 201)
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
    const fileId = await attachFile(context.env.DB, context.get('files'), context.get('session').operatorId, id, { name, contentType, bytes })
    await personRecordEvent(context.env, context.get('session').operator, 'person.file.attached', id)
    return context.json({ id: fileId }, 201)
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
    const result = await erasePerson(context.env, context.get('session').operator, id)
    await personRecordEvent(context.env, context.get('session').operator, 'person.erasure.requested', id)
    return context.json(result, 'receipt' in result && result.receipt?.phase === 'complete' ? 200 : 202)
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
