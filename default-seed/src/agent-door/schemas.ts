import type { JsonSchema, JsonSchemaObject } from '../../../modules/agent-door/index.ts'

export const text = (maxLength = 200): JsonSchema => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' })
export const id = text(200)
export const email: JsonSchema = { ...text(320) as object, format: 'email' }
export function object(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchemaObject {
  return { type: 'object', properties, required, additionalProperties: false }
}
export const empty = object({})
export const resultId = object({ id })
export const person = object({ id, name: text(), email, details: { type: 'object' }, created_at: text(), import_revision: { type: ['string', 'null'] } })
