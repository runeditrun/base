import { verifyJws } from './credentials.ts'
import { error, json } from './errors.ts'
import type { AuditRow } from './audit.ts'
import type { Runtime } from './types.ts'
import { publicCode } from './refusal-codes.mjs'

// BASE-AGENT-014: the paired Business pulls one value-free projection per
// audited call. The wire agreement is ADOPTING.md and schema/door-decisions.schema.json.

const READ_TYP = 'rer-agent-decisions+jwt'
const CLAIMS = 'aud,business,exp,iat,iss,sub'
const CURSOR = /^(?:0|[1-9][0-9]{0,15})$/

/** The eight public fields. Nothing else leaves the audit. */
export function projection(rt: Runtime, row: AuditRow): string {
  const known = row.tool === 'resources/read' || row.tool === `${rt.options.seed}.events.list` || rt.tools.some(tool => tool.name === row.tool)
  return JSON.stringify({
    id: row.id, tool: known ? row.tool : null, decision: row.decision, outcome: row.outcome,
    code: publicCode(row.outcome, row.code, rt.options.refusalCodes),
    revision: row.revision, at: row.at,
    // Embedded calls and the seed's own credentials carry no Business consent.
    consent: row.door === 'mcp' ? row.consent : null,
  })
}

/** Batched with every audit write. A changed projection takes a new change position;
 * the pairing is fixed when the call is first recorded, and erasure freezes the row. */
export function decisionWrite(rt: Runtime, row: AuditRow): D1PreparedStatement {
  const trust = rt.options.trust
  return rt.options.db.prepare(`INSERT OR REPLACE INTO agent_door_decisions(id,pairing,projection)
    SELECT ?1, CASE WHEN EXISTS(SELECT 1 FROM agent_door_decisions WHERE id=?1) THEN (SELECT pairing FROM agent_door_decisions WHERE id=?1)
      WHEN ?2 IS NULL THEN NULL
      ELSE json_array(?2, ?3, (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1 AND json_extract(envelope,'$.iss')=?2 AND json_extract(envelope,'$.sub')=?3)) END, ?4
    WHERE EXISTS(SELECT 1 FROM agent_door_audit WHERE id=?1 AND json_extract(row,'$.tombstone') IS NULL)
      AND NOT EXISTS(SELECT 1 FROM agent_door_decisions WHERE id=?1 AND projection=?4)`)
    .bind(row.id, trust?.issuer ?? null, trust?.installationId ?? null, projection(rt, row))
}

/** The Business named by the policy envelope adopted under this trust, when the credential is its own. */
async function reader(rt: Runtime, request: Request): Promise<string | null> {
  const trust = rt.options.trust!
  const bearer = request.headers.get('authorization')?.match(/^Bearer[ \t]+([^\s]+)$/i)?.[1]
  if (!bearer) return null
  const claims = await verifyJws(bearer, READ_TYP, trust.publicKeys)
  const now = rt.now() / 1000
  if (!claims || Object.keys(claims).sort().join() !== CLAIMS || claims.iss !== trust.issuer || claims.aud !== trust.appOrigin ||
    claims.sub !== trust.installationId || typeof claims.business !== 'string' || !claims.business ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || !Number.isFinite(now) ||
    (claims.iat as number) > now + 30 || (claims.exp as number) <= now || (claims.exp as number) - (claims.iat as number) > 300) return null
  const paired = await rt.options.db.prepare("SELECT json_extract(envelope,'$.business') AS business FROM agent_door_state WHERE id=1 AND json_extract(envelope,'$.iss')=? AND json_extract(envelope,'$.sub')=?")
    .bind(trust.issuer, trust.installationId).first<{ business: string | null }>()
  return paired?.business && paired.business === claims.business ? paired.business : null
}

/** GET /api/rer/agent-decisions?after=&limit= for the pairing's Business only. */
export async function decisionRead(rt: Runtime, request: Request): Promise<Response> {
  const trust = rt.options.trust
  if (!trust) return error('not_found', 404)
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ code: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' })
  const business = await reader(rt, request)
  if (!business) return json({ code: 'unauthenticated' }, 401, { 'www-authenticate': 'Bearer' })
  const params: Array<[string, string]> = []
  new URL(request.url).searchParams.forEach((value, key) => { params.push([key, value]) })
  const value = (name: string) => params.find(([key]) => key === name)?.[1]
  const after = value('after') ?? '0', limit = value('limit') ?? '200'
  if (params.some(([key]) => key !== 'after' && key !== 'limit') || new Set(params.map(([key]) => key)).size !== params.length ||
    !CURSOR.test(after) || !Number.isSafeInteger(Number(after)) || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) return error('invalid_request')
  const rows = (await rt.options.db.prepare('SELECT change,projection FROM agent_door_decisions WHERE pairing=json_array(?,?,?) AND change>? ORDER BY change LIMIT ?')
    .bind(trust.issuer, trust.installationId, business, Number(after), Number(limit)).all<{ change: number; projection: string }>()).results
  const body = { decisions: rows.map(row => JSON.parse(row.projection)), cursor: rows.length ? String(rows.at(-1)!.change) : after }
  return request.method === 'HEAD' ? new Response(null, { headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } }) : json(body)
}
