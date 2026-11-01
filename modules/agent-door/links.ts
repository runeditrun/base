import { offers } from './capabilities.mjs'
import { businessRole } from './people.ts'
import { pageStyle } from './page-style.ts'
import type { Person, ResourceDefinition, Runtime } from './types.ts'

// BASE-AGENT-015: one Base destination on the seed's own origin. A link carries
// only a reference; the seed maps it to its own page after native sign-in, its
// setup gate and a current-access check. Nothing in the request is authority.
export const OPEN_PATH = '/app/open'
const AUDIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VARIABLE = /^\{[^{}]+\}$/
export type OpenGate = (person: Person, request: Request) => Response | null | Promise<Response | null>
/** `gate` is the seed's setup (or other first-run) gate; `signIn` names its native sign-in, `/signin` by default. */
export interface OpenOptions { gate?: OpenGate; signIn?(returnTo: string): string }
type Reference = { kind: 'resource'; uri: string; resource: ResourceDefinition } | { kind: 'audit'; id: string }

const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }
// One page, byte for byte, for every refusal: missing, forbidden and malformed cannot be told apart.
// The Agents page style is inline under a hash, so no per-response nonce changes the bytes.
const unavailable = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not available</title><style>${pageStyle}</style><link rel="stylesheet" href="/rer-theme.css"></head><body><main id="main" data-link-unavailable><h1>This link is not available</h1><p>It may be mistyped, or it may not be yours to open. Ask whoever sent it to check.</p><p><a href="/app">Open the app</a></p></main></body></html>`
let styleHash: Promise<string> | undefined
const hash = () => styleHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(pageStyle)).then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))))
export async function notAvailable(head = false): Promise<Response> {
  return new Response(head ? null : unavailable, { status: 404, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; style-src 'self' 'sha256-${await hash()}'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` } })
}
const seeOther = (location: string) => new Response(null, { status: 303, headers: { ...headers, location } })

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** Each template variable is one safe segment: 1-128 of A-Z a-z 0-9 . _ ~ -, never . or .. */
function matches(template: string, uri: string): boolean {
  const pattern = template.split(/(\{[^{}]+\})/).map(part => VARIABLE.test(part) ? '([A-Za-z0-9._~-]{1,128})' : escapeRegExp(part)).join('')
  const found = new RegExp(`^${pattern}$`).exec(uri)
  return !!found && found.slice(1).every(value => value !== '.' && value !== '..')
}

/** The single reference in a well-formed link, or null for every malformed one. */
export function linkReference(rt: Runtime, url: URL): Reference | null {
  const params: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => { params.push([key, value]) })
  if (url.pathname !== OPEN_PATH || params.length !== 1) return null
  const [[key, value]] = params as [[string, string]]
  if (key === 'audit') return AUDIT_ID.test(value) ? { kind: 'audit', id: value } : null
  // The value is decoded once; a remaining % is a second encoding layer.
  if (key !== 'resource' || value.includes('%')) return null
  const resources = offers(rt.options.capabilities, 'resources') ? rt.options.resources ?? [] : []
  const resource = resources.find(item => matches(item.uriTemplate, value))
  return resource ? { kind: 'resource', uri: value, resource } : null
}

const local = (path: unknown): path is string => typeof path === 'string' && path.length <= 2048 && path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(path)

async function target(rt: Runtime, person: Person, reference: Reference): Promise<string | null> {
  if (reference.kind === 'resource') return await reference.resource.page?.(reference.uri, person, rt.options.db) ?? null
  const role = businessRole(rt.options.people, person)
  if (role !== 'owner' && role !== 'editor') return null
  const row = await rt.options.db.prepare('SELECT 1 AS found FROM agent_door_audit WHERE id=?').bind(reference.id).first<{ found: number }>()
  return row ? `/agents/audit/${reference.id}` : null
}

/** GET /app/open. Mount it before the seed's generic setup redirect and pass that setup as `gate`. */
export async function openLink(rt: Runtime, request: Request, { gate, signIn }: OpenOptions = {}): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  const head = request.method === 'HEAD', reference = linkReference(rt, url)
  if (!reference) return notAvailable(head)
  // Only the native session counts: no bearer token, Business cookie or query value.
  const native = new Headers(request.headers); native.delete('authorization')
  const person = await rt.options.people.session(new Request(request.url, { headers: native }))
  const back = url.pathname + url.search
  if (!person?.active) return seeOther(signIn ? signIn(back) : `/signin?returnTo=${encodeURIComponent(back)}`)
  const gated = gate ? await gate(person, request) : null
  if (gated) return gated
  const current = await rt.options.people.person(person.id)
  const path = current?.active ? await target(rt, current, reference) : null
  return local(path) ? seeOther(path) : notAvailable(head)
}
