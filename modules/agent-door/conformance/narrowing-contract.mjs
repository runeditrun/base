const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const targets = /^(?:id|target_id|client_id|endpoint_id|monitor_id|runner_id)$/;

/** Deliberately bounded: fixed native revoke/reduce, selected only by target id. */
export function narrowingContract(tool, schema = tool?.inputSchema) {
 if (tool?.widens !== false || tool.readOnly !== false || !['revoke', 'narrow'].includes(tool.narrowing?.effect)
  || tool.narrowing?.reason !== 'closed-target-input' || !object(schema) || schema.type !== 'object'
  || schema.additionalProperties !== false || !object(schema.properties)) return false;
 if (Object.keys(tool.narrowing).some(key => !['effect', 'reason'].includes(key))) return false;
 const fields = Object.entries(schema.properties).filter(([name]) => !['idempotency_key', 'expected_revision'].includes(name));
 // No references, unions, pattern properties, nested payloads or other schema
 // channels can introduce a person, role, scope or grant to add.
 if (Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', 'description', 'title'].includes(key))) return false;
 return fields.length > 0 && fields.every(([name, field]) => targets.test(name) && object(field) && field.type === 'string'
  && Object.keys(field).every(key => ['type', 'minLength', 'maxLength', 'pattern', 'format', 'description', 'title'].includes(key)))
  && Array.isArray(schema.required) && fields.some(([name]) => schema.required.includes(name));
}
