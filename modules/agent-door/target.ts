import type { NativeTarget, ToolContext, ToolDefinition } from './types.ts'
import { validateSchema } from './json-schema.ts'
import { ToolRefusal } from './errors.ts'

/** Seed-owned, read-only attribution. Native authorization stays in the tool. */
export async function resolveTarget(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<NativeTarget | null> {
  const target = await tool.target?.(args, ctx) ?? null
  if (target === null) return null
  if (!validateSchema({ type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: {
    kind: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 },
  } }, target)) throw new ToolRefusal('target_invalid')
  return { kind: target.kind, id: target.id }
}
