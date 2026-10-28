import type { Authority, ClassAndFacts, CallResult, Invocation, Principal, ResourceContext, Runtime, ToolContext, ToolDefinition, UndoContext, ApprovalDisplaySummary } from './types.ts'
import { validateSchema } from './json-schema.ts'
import { ToolRefusal } from './errors.ts'
import { canonical } from './policy/document.ts'
import { preparedBy } from './people.ts'
import { classDefinition } from './policy/catalogue.ts'
import { removeUsage } from './counting.ts'
import { policyState } from './policy-store.ts'
import { currentGrant } from './audit.ts'

export interface Effect { type: string; uri: string; data?: Record<string, unknown> }
export const authorityOf = (principal: Principal): Authority => ({ agent: principal.agent, client: principal.client ?? null, scopes: [...principal.scopes], consent: principal.consent ?? null })
export const invocationOf = (principal: Principal): Invocation => ({ person: { id: principal.person.id }, ...authorityOf(principal) })
export const resourceContext = (rt: Runtime, principal: Principal): ResourceContext => ({ person: principal.person, db: rt.options.db, ...authorityOf(principal) })
export const principalOf = ({ person, agent, scopes, consent, client }: ResourceContext): Principal => ({ person, agent, scopes: [...scopes], ...(consent ? { consent } : {}), ...(client ? { client } : {}) })
export function context(rt: Runtime, principal: Principal, door: ToolContext['door'], effects: Effect[], approvers: ToolContext['approvers'] = []): ToolContext {
  return { db: rt.options.db, person: principal.person, ...authorityOf(principal), actor: preparedBy(principal), seed: rt.options.seed, origin: rt.options.origin, now: rt.now, door, approvers,
    invocation: invocationOf(principal), emit(type, uri, data) { effects.push({ type, uri, data }) } }
}
export async function classify(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<ClassAndFacts[]> {
  const classes = await tool.classify(args, ctx)
  if (!Array.isArray(classes) || !classes.length || new Set(classes.map(item => item.class)).size !== classes.length || classes.some(item => !tool.classes.includes(item.class) || !item.facts || !Number.isSafeInteger(item.facts.measure) || item.facts.measure < 0 || classDefinition(item.class).facts.some(field => typeof item.facts[field as keyof typeof item.facts] !== 'string') || (item.facts.currency !== undefined && !/^[A-Z]{3}$/.test(item.facts.currency)) || (item.facts.counterparty !== undefined && !['internal','known','new','public'].includes(item.facts.counterparty)) || (item.facts.direction !== undefined && !['widens','narrows'].includes(item.facts.direction)))) throw new Error('classification_invalid')
  return classes
}
export const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('')
export const sameFacts = (a: ClassAndFacts[], b: ClassAndFacts[]) => canonical([...a].sort((x, y) => x.class.localeCompare(y.class))) === canonical([...b].sort((x, y) => x.class.localeCompare(y.class)))
/** Final admission of saved authority, possibly long after its request: the
 * sponsor, agent and consent must stand, and scopes narrow to the current grant. */
export async function readmit(rt: Runtime, saved: Principal): Promise<Principal | 'consent_revoked' | 'sponsor_unavailable'> {
  const person = await rt.options.people.person(saved.person.id)
  const agent = await rt.options.db.prepare('SELECT revoked FROM agent_door_agents WHERE id=?').bind(saved.agent.id).first<{ revoked: number }>()
  const state = await policyState(rt)
  if (saved.consent && state.revoked.consents.includes(saved.consent)) return 'consent_revoked'
  if (revoked(state, saved) || !person?.active || person.id !== saved.person.id || agent?.revoked) return 'sponsor_unavailable'
  const grant = await currentGrant(rt, saved.agent.id)
  return { ...saved, person, scopes: grant ? saved.scopes.filter(scope => grant.includes(scope)) : [...saved.scopes] }
}
export async function runTool(rt: Runtime, tool: ToolDefinition, args: Record<string, unknown>, principal: Principal, result: CallResult, door: ToolContext['door'], approvers: ToolContext['approvers'] = [], usageId = result.decision!.id): Promise<{ result: CallResult; effects: Effect[]; undo?: unknown }> {
  const effects: Effect[] = []
  try {
    const value = await tool.run(args, context(rt, principal, door, effects, approvers))
    if (!validateSchema(tool.outputSchema, value.result)) return { result: { ...result, outcome: 'refused', code: 'output_invalid' }, effects, undo: value.undo }
    return { result: { ...result, outcome: 'done', result: value.result, resources: value.resources, untrusted: tool.untrusted }, effects, undo: value.undo }
  } catch (cause) {
    if (cause instanceof ToolRefusal) { await removeUsage(rt, usageId); return { result: { ...result, outcome: 'refused', code: cause.code, fields: cause.details }, effects: [] } }
    throw cause
  }
}
export async function saveCall(rt: Runtime, principal: Principal, key: string | null, result: CallResult) {
  if (key !== null) await rt.options.db.prepare('UPDATE agent_door_calls SET state=?,outcome=? WHERE agent=? AND key=?')
    .bind(result.outcome, JSON.stringify(result), principal.agent.id, key).run()
}

export const revoked = (state: Awaited<ReturnType<typeof policyState>>, principal: Pick<Principal, 'agent' | 'consent'>) => state.revoked.agents.includes(principal.agent.id) || !!principal.consent && state.revoked.consents.includes(principal.consent)
export function selfEscalation(authority: { subject: string; widens: boolean } | null | undefined, principal: Principal) {
  if (!authority?.widens) return false
  const subject = authority.subject.trim().toLowerCase()
  return [principal.person.id, principal.person.email, principal.agent.id].some(id => id.toLowerCase() === subject)
}
export function undoContext(rt: Runtime, person: Principal['person'], door: ToolContext['door'], effects: Effect[]): UndoContext {
  return { db: rt.options.db, person, agent: null, actor: { kind: 'person', person: { id: person.id, name: person.name }, label: person.name }, seed: rt.options.seed, origin: rt.options.origin, now: rt.now, door,
    emit(type, uri, data) { effects.push({ type, uri, data }) } }
}
export async function summary(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<ApprovalDisplaySummary> {
  if (tool.readOnly) return tool.name === 'resources/read' ? { uri: String(args.uri) } : { arguments: args }
  const value = await tool.summary!(args, ctx)
  const schema = { type: 'object', additionalProperties: false, properties: {
    target: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
    recipients: { type: 'array', items: { type: 'string' } }, amount: { type: 'object', required: ['value','currency'], additionalProperties: false, properties: { value: { type: 'number' }, currency: { type: 'string' } } },
    payee: { type: 'string' }, role: { type: 'string' }, items: { type: 'array', items: { type: 'string' } },
  } }
  if (!validateSchema(schema, value)) throw new Error('summary_invalid')
  return value
}
