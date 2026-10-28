import type { AgentDoor, ToolContext } from '../types.ts'

export async function queueRecord(args: Record<string, unknown>, ctx: ToolContext) {
  const id = crypto.randomUUID()
  const saved = { args: { id: args.id, value: args.value, idempotency_key: crypto.randomUUID() }, who: { person: ctx.person, agent: ctx.agent, consent: ctx.consent } }
  await ctx.db.prepare('INSERT INTO test_jobs(id,saved) VALUES(?,?)').bind(id, JSON.stringify(saved)).run()
  ctx.emit('record.queued', `synthetic://job/${id}`)
  return { result: { id, value: args.value, version: 0 } }
}

/** Native scheduler and worker doors retain the saved authority, never input attribution. */
export async function queuedRecord(path: string, door: AgentDoor, db: D1Database) {
  const match = /^\/__jobs\/([^/]+)\/(run|reschedule)$/.exec(path)
  if (!match) return new Response(null, { status: 404 })
  const row = await db.prepare('SELECT saved FROM test_jobs WHERE id=?').bind(match[1]).first<{ saved: string }>()
  if (!row) return new Response(null, { status: 404 })
  const saved = JSON.parse(row.saved)
  if (match[2] === 'run') return Response.json(await door.invoke('synthetic.records.write', saved.args, saved.who))
  const id = crypto.randomUUID()
  saved.args.idempotency_key = crypto.randomUUID()
  await db.prepare('INSERT INTO test_jobs(id,saved) VALUES(?,?)').bind(id, JSON.stringify(saved)).run()
  return Response.json({ id })
}
