import { invalid, missing } from '../errors.mjs';
import { schemasFromBuild, schemaFromMigrations } from './schema.mjs';
import { checkSchemaObjects } from './check.mjs';
import { measureStatements, readStatementsFile } from './statements.mjs';
import { sizeReport } from './report.mjs';
import { buildFixtures, declared, growthRequested } from './grow.mjs';

// The one schema a statements file runs against: --migrations DIR, else the build's only D1 database.
async function statementsSchema(options) {
  if (options.migrations) return (await schemaFromMigrations(options.migrations)).db;
  const schemas = await schemasFromBuild(options.cwd);
  if (!schemas.length) throw missing('This build has no D1 database to check statements against. Pass --migrations DIR.');
  if (schemas.length > 1) throw invalid(`This build declares several D1 databases (${schemas.map(schema => schema.binding).join(', ')}); pass --migrations DIR for the one the statements run against.`);
  return schemas[0].db;
}

export const undeclaredLine = 'Size check: undeclared (no size-check.json).';

/**
 * The whole size check, the one code `rer size` and the last step of `rer verify` both run: statement size, then, with
 * a size-check.json (or --declaration FILE), the declared shape built at a small and a large size and every declared
 * flow run on each through a rows-read meter. `options` are rer size's (`cwd`, `json`, `declaration`, `statements`,
 * `migrations`, `writeStatements`); lines go to `out.human`. Resolves { ok, details }, ok being false for a statement
 * at or over the margin, a size that fails to build or a failing flow. It does not take a job-queue slot: the caller holds one.
 */
export async function measureSize(options, out) {
  let records, sqlOf, unit;
  if (options.writeStatements && !growthRequested(options)) throw invalid('--write-statements writes what the declared flows ran: add a size-check.json at the checkout root, or --declaration FILE.');
  // A declaration says where the build is, so it is read before the build is.
  const loaded = growthRequested(options) ? await declared(options) : undefined;
  if (options.statements) {
    const statements = await readStatementsFile(options.statements), sql = new Map(statements.map(statement => [statement.name, statement.sql]));
    records = measureStatements(await statementsSchema(options), statements, { exact: options.json });
    sqlOf = record => sql.get(record.name) ?? '';
    unit = 'statements';
  } else {
    const schemas = options.migrations ? [await schemaFromMigrations(options.migrations)] : await schemasFromBuild(options.cwd, { wrangler: loaded?.declaration.build.wrangler });
    if (!schemas.length) {
      out.human('Statement size: this build has no D1 database; nothing to check.');
      records = [];
    } else {
      ({ records, sqlOf } = checkSchemaObjects(schemas, { exact: options.json }));
      unit = 'view and trigger statements';
    }
  }
  let ok = records.every(record => record.ok);
  if (!options.json && records.length) for (const line of sizeReport(records, sqlOf, unit)) out.human(line);
  const details = { statements: records.map(({ name, fromItems, depth, ok, error }) => ({ name, fromItems: fromItems ?? null, depth, ok, ...(error ? { error } : {}) })) };
  if (loaded) {
    const { ok: built, flows, queueConsumersMeasured, ...sizes } = await buildFixtures(options, out, loaded);
    ok = ok && built;
    details.size = sizes;
    details.queueConsumersMeasured = queueConsumersMeasured;
    if (flows) details.flows = flows;
  } else if (!options.statements && !options.migrations) out.human(undeclaredLine);
  return { ok, details };
}

/** rer size: exit 1 if any statement is at or over the margin, a size fails to build or a flow fails, 0 if none, 3 with
 * no build and no --migrations. */
export async function sizeCommand(options, out) {
  const { ok, details } = await measureSize(options, out);
  out.result(ok, ok ? 0 : 1, details);
  return ok ? 0 : 1;
}
