import { measureStatements } from './statements.mjs';
import { schemaObjects } from './schema-objects.mjs';

/** Every view and trigger statement of each schema ({ binding, db }), measured:
 * { records, sql } where sql maps a record to its statement text. A binding
 * names the statements of a build with several databases. */
export function checkSchemaObjects(schemas, { exact = false } = {}) {
  const records = [], text = new Map();
  for (const { binding, db } of schemas) {
    const { statements } = schemaObjects(db);
    const named = statements.map(statement => ({ ...statement, name: binding ? `${statement.name} [${binding}]` : statement.name }));
    for (const statement of named) text.set(statement.name, statement.sql);
    records.push(...measureStatements(db, named, { exact }));
  }
  return { records, sqlOf: record => text.get(record.name) ?? '' };
}
