import { invalid, missing } from '../errors.mjs';
import { schemasFromBuild, schemaFromMigrations } from './schema.mjs';
import { checkSchemaObjects } from './check.mjs';
import { measureStatements, readStatementsFile } from './statements.mjs';
import { sizeReport } from './report.mjs';
import { buildFixtures, growthRequested } from './grow.mjs';

// The one schema a statements file runs against: --migrations DIR, else the build's only D1 database.
async function statementsSchema(options) {
  if (options.migrations) return (await schemaFromMigrations(options.migrations)).db;
  const schemas = await schemasFromBuild(options.cwd);
  if (!schemas.length) throw missing('This build has no D1 database to check statements against. Pass --migrations DIR.');
  if (schemas.length > 1) throw invalid(`This build declares several D1 databases (${schemas.map(schema => schema.binding).join(', ')}); pass --migrations DIR for the one the statements run against.`);
  return schemas[0].db;
}

/** rer size: statement size against D1's limits, then, with a size-check.json, the declared shape built at a small
 * and a large size on local D1 and every declared flow run on each through a rows-read meter. Exit 1 if any statement is at or over the margin or a size fails to build, 0 if
 * none, 3 with no build and no --migrations. */
export async function sizeCommand(options, out) {
  let records, sqlOf, unit;
  if (options.writeStatements && !growthRequested(options)) throw invalid('--write-statements writes what the declared flows ran: add a size-check.json at the checkout root, or --declaration FILE.');
  if (options.statements) {
    const statements = await readStatementsFile(options.statements), sql = new Map(statements.map(statement => [statement.name, statement.sql]));
    records = measureStatements(await statementsSchema(options), statements, { exact: options.json });
    sqlOf = record => sql.get(record.name) ?? '';
    unit = 'statements';
  } else {
    const schemas = options.migrations ? [await schemaFromMigrations(options.migrations)] : await schemasFromBuild(options.cwd);
    if (!schemas.length) {
      out.human('Statement size: this build has no D1 database; nothing to check.');
      if (!growthRequested(options)) {
        out.result(true, 0, { statements: [] });
        return 0;
      }
      records = [];
    } else {
      ({ records, sqlOf } = checkSchemaObjects(schemas, { exact: options.json }));
      unit = 'view and trigger statements';
    }
  }
  let ok = records.every(record => record.ok);
  if (!options.json && records.length) for (const line of sizeReport(records, sqlOf, unit)) out.human(line);
  const details = { statements: records.map(({ name, fromItems, depth, ok, error }) => ({ name, fromItems: fromItems ?? null, depth, ok, ...(error ? { error } : {}) })) };
  // With a size-check.json (or --declaration), the declared shape is then built at a small and a large size.
  if (!options.statements && growthRequested(options)) {
    const { ok: built, flows, queueConsumersMeasured, ...sizes } = await buildFixtures(options, out);
    ok = ok && built;
    details.size = sizes;
    if (flows) Object.assign(details, { flows, queueConsumersMeasured });
  }
  out.result(ok, ok ? 0 : 1, details);
  return ok ? 0 : 1;
}
