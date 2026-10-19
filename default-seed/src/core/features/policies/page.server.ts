import { AuthError } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../platform/bindings.server'
import { operatorAuth } from '../../platform/auth/session.server'
import { actorName, fieldLabel, operatorDirectory, readableTime } from '../../../../../foundation/runtime/actor'
import { seeOther } from '../../../../../foundation/runtime/command-receipts'
import { themeFrame } from '../../../../../foundation/runtime/theme-frame'
import { businessTimeZone as timeZone, identity } from '../../app/identity'
import { theme } from '../../app/theme'

const PATH = '/app/policies'
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }
const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
type Policies = NonNullable<ReturnType<typeof operatorAuth>['scheduledPolicies']>
type Listing = Awaited<ReturnType<Policies['list']>>
type Approval = Listing['approvals'][number]
type Run = Awaited<ReturnType<Policies['runs']>>[number]

const field = (label: string, value: string) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`
const time = (value: string | number) => readableTime(value, timeZone)

// Parameters are part of the exact approval: render every nested value without
// the depth limit appropriate to a short activity-feed evidence summary.
function parametersHtml(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `<ol>${value.map(item => `<li>${parametersHtml(item)}</li>`).join('')}</ol>` : '<p>Empty list</p>'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    return entries.length ? `<dl>${entries.map(([key, item]) => `<dt>${escape(fieldLabel(key))} (<code>${escape(key)}</code>)</dt><dd>${parametersHtml(item)}</dd>`).join('')}</dl>` : '<p>Empty object</p>'
  }
  const text = value === null ? 'Null' : typeof value === 'boolean' ? (value ? 'True' : 'False') : typeof value === 'string' ? JSON.stringify(value) : String(value)
  return `<span>${escape(text)}</span>`
}

function revokeForm(approval: Approval): string {
  return approval.revokedAt === null ? `<form method="post" action="${PATH}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="approvalId" value="${escape(approval.id)}"><button>Revoke approval</button></form>` : ''
}

function approvalHtml(approval: Approval, directory: Map<string, string>): string {
  return `<dl>${field('Approval ID', approval.id)}${field('Policy ID', approval.policyId)}${field('Approved version hash', approval.versionHash)}${field('Approved by', actorName(directory, approval.ownerId))}${field('Owner authority version', String(approval.ownerVersion))}${field('Approved at', time(approval.approvedAt))}${field('Revoked at', approval.revokedAt === null ? 'Not revoked' : time(approval.revokedAt))}</dl>`
}

function policyHtml(policy: Listing['policies'][number], directory: Map<string, string>): string {
  const definition = policy.definition
  const actionLabels: Record<string, string> = { 'operators:deactivate': 'Deactivate operators', 'operators:reactivate': 'Reactivate operators' }
  return `<section><h2>${escape(definition.id)}</h2><dl>${field('Policy ID', definition.id)}${field('Job kind', definition.kind)}${field('State', fieldLabel(policy.state))}${field('Version hash', policy.versionHash)}</dl>
<h3>Parameters</h3>${parametersHtml(definition.parameters)}
<h3>Allowed actions and complete scopes</h3>${definition.actions.length ? `<ol>${definition.actions.map(({ action, scope }) => `<li><p>${escape(actionLabels[action] ?? fieldLabel(action))} (<code>${escape(action)}</code>)</p><dl>${field('Allowed roles', scope.roles.join(', '))}${field('Operator restriction', scope.operatorIds === undefined ? 'Any operator matching the other scope requirements' : scope.operatorIds.length ? scope.operatorIds.map(id => `${actorName(directory, id)} (${id})`).join(', ') : 'No operators')}${field('Inactivity requirement', scope.inactiveDays === undefined ? 'None' : `No OA session created in the last ${scope.inactiveDays} days; account creation is used for someone who has never signed in.`)}</dl></li>`).join('')}</ol>` : '<p>No actions allowed.</p>'}
<p>Owner accounts and invitations cannot be targeted. Inactivity measures sign-in sessions, not activity in the app.</p>
<h3>Current approval</h3>${policy.approval ? approvalHtml(policy.approval, directory) + revokeForm(policy.approval) : '<p>No approval recorded.</p>'}
<form method="post" action="${PATH}"><input type="hidden" name="action" value="approve"><input type="hidden" name="policyId" value="${escape(definition.id)}"><input type="hidden" name="versionHash" value="${escape(policy.versionHash)}"><button>Approve this exact version</button></form></section>`
}

function runHtml(run: Run, directory: Map<string, string>): string {
  return `<section><h3>${escape(run.policyId)}</h3><dl>${field('Actor', `policy:${run.policyId}@${run.versionHash}`)}${field('Run ID', run.id)}${field('Approval ID', run.approvalId ?? 'No approval')}${field('Approved by', run.approvedBy ? actorName(directory, run.approvedBy) : 'No approving owner')}${field('Started at', time(run.startedAt))}${field('Finished at', run.finishedAt === null ? 'Not finished' : time(run.finishedAt))}${field('Outcome', fieldLabel(run.status))}${field('Refusal or error code', run.error ?? 'None')}</dl></section>`
}

async function page(content: string, status = 200, head = false): Promise<Response> {
  const frame = await themeFrame(theme)
  const body = `<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scheduled policies · ${escape(identity.product)}</title>${frame.head}</head><body><main>${frame.brand}<h1>Scheduled policies</h1>${content}<p><a href="/app">Back to the operator app</a></p></main></body></html>`
  return new Response(head ? null : body, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}` } })
}

/** Owner-only native forms for GET, HEAD and POST /app/policies. */
export async function policyPageResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PATH) return null
  if (bindings.AUTH_ORIGIN && url.origin !== bindings.AUTH_ORIGIN) return new Response('Not found', { status: 404, headers })
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD, POST' } })
  if (request.method === 'POST' && (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return new Response('Cross-site request refused', { status: 403, headers })
  try {
    const auth = operatorAuth(bindings)
    const session = await auth.getSession(request)
    if (!session) return seeOther(`/signin?returnTo=${encodeURIComponent(PATH)}`, headers)
    if (session.operator.role !== 'owner') return new Response('Owner role required', { status: 403, headers })
    const policies = auth.scheduledPolicies
    if (!policies) return new Response('Not found', { status: 404, headers })
    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null)
      const action = form?.get('action')
      const policyId = form?.get('policyId'), versionHash = form?.get('versionHash'), approvalId = form?.get('approvalId')
      if (action === 'approve' && typeof policyId === 'string' && policyId && typeof versionHash === 'string' && versionHash) {
        await policies.approve(request, { policyId, versionHash })
      } else if (action === 'revoke' && typeof approvalId === 'string' && approvalId) {
        await policies.revoke(request, { approvalId })
      } else return page('<p role="alert">Choose an approval action from the policy page.</p><p><a href="/app/policies">Review scheduled policies</a></p>', 400)
      return seeOther(PATH, headers)
    }
    const [listing, runs, directory] = await Promise.all([policies.list(request), policies.runs(request), operatorDirectory(bindings.DB)])
    return page(`<p>Review the complete definition before approving its exact version. Changes to any definition field require approval again. Reapproval replaces the previous approval.</p><p>Revocation stops future runs and further actions in an active run. It cannot undo actions already committed.</p>
${listing.policies.length ? listing.policies.map(policy => policyHtml(policy, directory)).join('') : '<p>No scheduled policies declared.</p>'}
<h2>Approval history</h2>${listing.approvals.length ? listing.approvals.map(approval => `<section><h3>${escape(approval.policyId)}</h3>${approvalHtml(approval, directory)}${revokeForm(approval)}</section>`).join('') : '<p>No approvals yet.</p>'}
<h2>Run history</h2><p>Outcomes include refused and failed attempts. A failed run may have committed earlier actions; review the activity audit for those actions.</p>${runs.length ? runs.map(run => runHtml(run, directory)).join('') : '<p>No runs yet.</p>'}`, 200, request.method === 'HEAD')
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    const code = /^[a-z][a-z0-9_:-]{0,99}$/.test(error.code) ? error.code : 'request_refused'
    return page(`<p role="alert">Request refused (${escape(code)}).</p><p><a href="/app/policies">Review current policies and approvals</a></p>`, error.status, request.method === 'HEAD')
  }
}
