import { z } from 'zod'
import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { actorLine, evidenceHtml, fieldLabel, operatorDirectory, readableTime } from '../../../../../foundation/runtime/actor'
import { CommandKeyError, commandKey, commandKeyInput, readReceipt, runOnce, seeOther } from '../../../../../foundation/runtime/command-receipts'
import { themeFrame } from '../../../../../foundation/runtime/theme-frame'
import { businessTimeZone as timeZone, identity } from '../../app/identity'
import { theme } from '../../app/theme'
import { personRecordEvent } from '../../../agent-door/person-events.server'
import { createPerson } from './repository.server'

// The reference server-rendered page for Base's two shared presentation rules:
// actors and evidence read as names, times and labelled fields (actor.ts), and
// a create form posts once, then 303s to this GET (command-receipts.ts).
const PATH = '/app/people'
const personForm = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320) })
const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }
const actions: Record<string, string> = { 'person.created': 'Added a person', 'note.added': 'Added a note', 'file.attached': 'Attached a file', 'person.erasure_requested': 'Asked to erase a person' }

async function page(bindings: Bindings, notice: string, status = 200) {
  const directory = await operatorDirectory(bindings.DB)
  const people = (await bindings.DB.prepare('SELECT name,email,created_at FROM people ORDER BY created_at DESC LIMIT 50').all<{ name: string; email: string; created_at: string }>()).results
  const events = (await bindings.DB.prepare('SELECT actor,action,details,created_at FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 20').all<{ actor: string; action: string; details: string; created_at: string }>()).results
  const frame = await themeFrame(theme)
  const body = `<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>People · ${escape(identity.product)}</title>${frame.head}</head><body><main>${frame.brand}
<h1>People</h1><p><a href="/app/import">Move your people in or export people</a></p>${notice}
<form method="post" action="${PATH}">${commandKeyInput()}<label>Name<input name="name" required maxlength="200" autocomplete="off"></label><label>Email<input name="email" type="email" required maxlength="320" autocomplete="off"></label><button>Add person</button></form>
<h2>Everyone</h2>${people.length ? `<ul>${people.map(person => `<li>${escape(person.name)} (${escape(person.email)}) · added ${escape(readableTime(person.created_at, timeZone))}</li>`).join('')}</ul>` : '<p>No people yet.</p>'}
<h2>Recent activity</h2>${events.length ? events.map(event => `<section><h3>${escape(actions[event.action] ?? fieldLabel(event.action.replaceAll('.', '_')))}</h3><p>${escape(actorLine(directory, event.actor, event.created_at, timeZone))}</p>${evidenceHtml(event.details, { directory, timeZone })}</section>`).join('') : '<p>Nothing has happened yet.</p>'}
<p><a href="/app">Back to the operator app</a></p></main></body></html>`
  return new Response(body, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}` } })
}

/** GET and POST /app/people for signed-in owners and admins; null for every other path. */
export async function peoplePageResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PATH) return null
  if (bindings.AUTH_ORIGIN && url.origin !== bindings.AUTH_ORIGIN) return new Response('Not found', { status: 404, headers })
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD, POST' } })
  if (request.method === 'POST' && (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return new Response('Cross-site request refused', { status: 403, headers })
  const session = await sessionForRequest(bindings, request)
  if (!session) return seeOther(`/signin?returnTo=${encodeURIComponent(PATH)}`, headers)
  if (!['owner', 'admin'].includes(session.operator.role)) return new Response('Operator role required', { status: 403, headers })
  const actor = session.operatorId
  if (request.method !== 'POST') {
    const done = await readReceipt<{ id: string; name: string }>(bindings.DB, actor, url.searchParams.get('done'))
    return page(bindings, done?.command === 'person.create' ? `<p role="status">Added ${escape(done.result.name)}.</p>` : '')
  }
  const form = await request.formData().catch(() => null)
  const parsed = personForm.safeParse({ name: form?.get('name'), email: form?.get('email') })
  if (!form || !parsed.success) return page(bindings, '<p role="alert">Enter a name and an email address.</p>', 400)
  try {
    const key = commandKey(form)
    await runOnce(bindings.DB, { actor, command: 'person.create', key }, async () => {
      const id = await createPerson(bindings.DB, actor, { ...parsed.data, details: {} })
      await personRecordEvent(bindings, session.operator, 'person.created', id)
      return { result: { id, name: parsed.data.name } }
    })
    return seeOther(`${PATH}?done=${key}`, headers)
  } catch (error) {
    if (error instanceof CommandKeyError) return page(bindings, `<p role="alert">${escape(error.message)}</p>`, error.status)
    throw error
  }
}
