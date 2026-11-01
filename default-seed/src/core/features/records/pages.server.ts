import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { readableTime } from '../../../../../foundation/runtime/actor'
import { seeOther } from '../../../../../foundation/runtime/command-receipts'
import { themeFrame } from '../../../../../foundation/runtime/theme-frame'
import { businessTimeZone as timeZone, identity } from '../../app/identity'
import { theme } from '../../app/theme'
import { readOperator, readPerson } from '../../../agent-door/repository.server'

// Each declared record's own page: the targets BASE-AGENT-015 links open after
// the shared destination checks access. Owners and admins see records, as on /app/people.
const RECORD = /^\/app\/(people|operators)\/([A-Za-z0-9._~-]{1,128})$/
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }
const field = (label: string, value: string) => `<dl><dt>${escape(label)}</dt><dd>${value}</dd></dl>`

async function page(title: string, content: string, status = 200) {
  const frame = await themeFrame(theme)
  const body = `<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(identity.product)}</title>${frame.head}</head><body><main>${frame.brand}${content}</main></body></html>`
  return new Response(body, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}` } })
}

async function person(bindings: Bindings, id: string) {
  const record = await readPerson(bindings.DB, id)
  if (!record) return null
  const notes = record.notes as Array<{ id: string; body: string; created_at: string }>
  return page(record.name, `<h1>${escape(record.name)}</h1><section data-record="person" data-record-id="${escape(record.id)}">${field('Email', escape(record.email))}${field('Added', escape(readableTime(record.created_at, timeZone)))}${field('Files', String(record.files.length))}</section>`
    + `<h2>Notes</h2>${notes.length ? `<ul>${notes.map(note => `<li>${escape(note.body)}</li>`).join('')}</ul>` : '<p>No notes yet.</p>'}<p><a href="/app/people">All people</a></p>`)
}

async function operator(bindings: Bindings, id: string) {
  const record = await readOperator(bindings.DB, id)
  if (!record) return null
  return page(record.displayName, `<h1>${escape(record.displayName)}</h1><section data-record="operator" data-record-id="${escape(record.id)}">${field('Email', escape(record.email))}${field('Role', escape(record.role))}${field('Access', escape(record.status))}</section><p><a href="/app">Back to the operator app</a></p>`)
}

/** GET /app/people/:id and /app/operators/:id; null for every other path. */
export async function recordPageResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  const url = new URL(request.url), match = RECORD.exec(url.pathname)
  if (!match) return null
  if (bindings.AUTH_ORIGIN && url.origin !== bindings.AUTH_ORIGIN) return new Response('Not found', { status: 404, headers })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  const session = await sessionForRequest(bindings, request)
  if (!session) return seeOther(`/signin?returnTo=${encodeURIComponent(url.pathname)}`, headers)
  if (!['owner', 'admin'].includes(session.operator.role)) return new Response('Operator role required', { status: 403, headers })
  const response = await (match[1] === 'people' ? person : operator)(bindings, match[2]!) ?? await page('Not found', '<h1>Not found</h1><p>This record does not exist.</p><p><a href="/app">Back to the operator app</a></p>', 404)
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
}
