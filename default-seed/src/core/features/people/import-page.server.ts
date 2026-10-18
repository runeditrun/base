import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { themeFrame } from '../../../../../foundation/runtime/theme-frame'
import { theme } from '../../app/theme'

/** The owner's move-in screen uses the same HTTP door as an approved Business import. */
export async function importPageResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/app/import') return null
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
  if (url.origin !== bindings.AUTH_ORIGIN || (request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase())) return new Response('Not found', { status: 404, headers })
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  const session = await sessionForRequest(bindings, request)
  if (!session) return new Response(null, { status: 303, headers: { ...headers, location: '/signin?returnTo=%2Fapp%2Fimport' } })
  if (session.operator.role !== 'owner') return new Response('Owner required', { status: 403, headers })
  const frame = await themeFrame(theme)
  return new Response(`<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Move your people in · ${theme.productName}</title>${frame.head}<link rel="stylesheet" href="/import-door.css"><script type="module" src="/import-door.js"></script></head><body><main>${frame.brand}
<h1>Move your people in</h1><p>Upload a people export, review what will change, then approve the import. Imported people stay inert: no mail or invitations are sent.</p>
<p><a href="/api/operator/import-export" download="people.json">Export people</a> · <a href="/app/people">View people</a></p>
<form id="upload"><label>People export (JSON)<input id="bundle" type="file" accept=".json,application/json" required></label><p>Use the people export from another installation. Names, emails and details move with their original references. Notes, files, access and installation archives are not supported here.</p><label><input id="catchup" type="checkbox">Update an earlier import from the same source</label><button>Upload and review</button></form>
<p id="notice" role="status" aria-live="polite"></p>
<section id="review" hidden><h2>Review your import</h2><dl id="counts"></dl><h3>Differences</h3><ul id="differences"></ul><h3>Rejections</h3><ul id="rejections"></ul><details><summary>Reviewed fingerprint</summary><p id="fingerprint"></p></details><form id="approve"><label><input id="confirmed" type="checkbox" required>I reviewed these changes and approve this import.</label><button>Apply reviewed import</button></form></section>
<section id="result" hidden><h2 id="result-title"></h2><p id="result-description"></p><button id="resume" hidden>Continue import</button><button id="reconcile" hidden>Reconcile native records</button><button id="undo" hidden>Undo import</button></section>
<section><h2>Import history</h2><p>Approvals from this screen and Business share the same history and undo.</p><div id="history"><p>Loading history…</p></div></section>
<section><h2>Business imports</h2><p>Your own imports always work. Business needs your explicit approval here. Revoked keys stay revoked when you enable it again.</p><form id="settings"><label><input id="enabled" type="checkbox">Allow approved Business imports</label><label>Revoke a signing key (optional)<input id="revoked-key" maxlength="64" pattern="[A-Za-z0-9_-]+" autocomplete="off"></label><button>Save import settings</button></form><p id="revocations"></p></section>
<p><a href="/app">Back to the operator app</a></p></main></body></html>`, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}` } })
}
