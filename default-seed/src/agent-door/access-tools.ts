import { defineTool, ToolRefusal, type ToolContext, type ToolDefinition } from '../../../modules/agent-door/index.ts'
import type { Bindings } from '../core/platform/bindings.server'
import { AuthError } from '../../../modules/operator-auth/index.mjs'
import { operatorAuth } from '../core/platform/auth/session.server'
import { operatorByEmail, readOperator, requirePeopleAccess } from './repository.server'
import { email, id, object, text } from './schemas'

const clauses = ['BASE-AGENT-002', 'BASE-AGENT-006', 'BASE-AGENT-009']
const role = { type: 'string', enum: ['admin', 'member'] }
const result = object({ id, role: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' } })
const operatorUri = (id: string) => `base://operator/${encodeURIComponent(id)}`
function native(bindings: Bindings, ctx: ToolContext) {
  const commands = operatorAuth(bindings).delegatedAdministration({ personId: ctx.person.id, auditLabel: ctx.actor.label, agentId: ctx.agent.id })
  const act = async <T>(work: () => Promise<T>) => { try { return await work() } catch (cause) { if (cause instanceof AuthError) throw new ToolRefusal(cause.code); throw cause } }
  return { invite: (input: Parameters<typeof commands.invite>[0]) => act(() => commands.invite(input)), setRole: (id: string, role: 'admin' | 'member') => act(() => commands.setRole(id, role)) }
}
async function roleTarget(args: Record<string, unknown>, ctx: ToolContext) {
  requirePeopleAccess(ctx.person)
  const target = await readOperator(ctx.db, args.id as string)
  if (!target) throw new ToolRefusal('operator_not_found')
  if (target.id === ctx.person.id || target.role === 'owner') throw new ToolRefusal('delegated_owner_change')
  return target
}
export function accessTools(bindings: Bindings): ToolDefinition[] {
  return [
    defineTool({
      name: 'base.access.invite', title: 'Invite a teammate', description: 'Send a native operator invitation and grant its pending access. The recipient is a new external counterparty.',
      scope: 'access:write', readOnly: false, inputSchema: object({ name: text(120), email, role }), outputSchema: result,
      classes: ['external', 'access'], clauses,
      classify(_args, ctx) {
        requirePeopleAccess(ctx.person)
        return [{ class: 'external', facts: { measure: 1, counterparty: 'new' } }, { class: 'access', facts: { measure: 1, direction: 'widens' } }]
      },
      authority(args) { return Promise.resolve({ subject: args.email as string, widens: true }) },
      summary(args, ctx) {
        requirePeopleAccess(ctx.person)
        const email = (args.email as string).trim().toLowerCase()
        return { target: { name: (args.name as string).trim(), email }, recipients: [email], role: args.role as string }
      },
      async run(args, ctx) {
        requirePeopleAccess(ctx.person)
        await native(bindings, ctx).invite({ email: args.email as string, displayName: (args.name as string).trim(), role: args.role as 'admin' | 'member', returnTo: '/app' })
        const target = await operatorByEmail(ctx.db, args.email as string)
        if (!target) throw new Error('Native invitation did not produce an operator')
        ctx.emit('operator.invited', operatorUri(target.id), { id: target.id, role: target.role, approved_by: ctx.approvers })
        return { result: { id: target.id, role: target.role, status: target.status, version: target.version } }
      },
    }),
    defineTool({
      name: 'base.access.role', title: 'Change a teammate role', description: 'Change a teammate between member and admin using native authorization. Delegations cannot change their sponsor or an owner.',
      scope: 'access:write', readOnly: false, inputSchema: object({ id, role }), outputSchema: result, classes: ['access'], clauses,
      async classify(args, ctx) {
        const target = await roleTarget(args, ctx)
        if (target.role === args.role) throw new ToolRefusal('role_unchanged')
        return [{ class: 'access', facts: { measure: 1, direction: args.role === 'admin' ? 'widens' : 'narrows' } }]
      },
      async revision(args, ctx) { return (await readOperator(ctx.db, args.id as string))?.version ?? null },
      async authority(args, ctx) { const target = await readOperator(ctx.db, args.id as string); return target ? { subject: target.id, widens: args.role === 'admin' && target.role !== 'admin' } : null },
      async summary(args, ctx) {
        const target = await roleTarget(args, ctx)
        return { target: { id: target.id, name: target.displayName, email: target.email }, role: args.role as string }
      },
      async run(args, ctx) {
        await roleTarget(args, ctx)
        const target = await native(bindings, ctx).setRole(args.id as string, args.role as 'admin' | 'member')
        ctx.emit('operator.role.changed', operatorUri(target.id), { id: target.id, role: target.role, version: target.version, approved_by: ctx.approvers })
        return { result: { id: target.id, role: target.role, status: target.status, version: target.version } }
      },
    }),
  ]
}
