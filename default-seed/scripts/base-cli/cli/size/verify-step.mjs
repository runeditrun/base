import '../sqlite-notice.mjs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RerError } from '../errors.mjs';
import { schemasFromBuild } from './schema.mjs';
import { checkSchemaObjects } from './check.mjs';
import { sizeReport } from './report.mjs';

/** The last step of rer verify: every view and trigger statement of each D1
 * binding's migrations, measured. A failure fails verify naming the object. */
export async function checkSizeStep(root, { report = () => {} } = {}) {
  const schemas = await schemasFromBuild(root);
  if (!schemas.length) {
    report('Statement size: this build has no D1 database; nothing to check.');
    return { databases: 0, statements: 0 };
  }
  const { records, sqlOf } = checkSchemaObjects(schemas);
  const lines = sizeReport(records, sqlOf, 'view and trigger statements');
  const failures = records.filter(record => !record.ok);
  if (failures.length) throw new RerError('statement_size_failed', `D1 would refuse the build's schema objects:\n${lines.join('\n')}`, 1, { failures: failures.map(({ name, fromItems, depth, error }) => ({ name, fromItems, depth, error })) });
  lines.forEach(report);
  return { databases: schemas.length, statements: records.length, fromItems: Math.max(0, ...records.map(record => record.fromItems)), depth: Math.max(1, ...records.map(record => record.depth ?? 0)) };
}

if (process.argv[1] && await realpath(new URL(import.meta.url)) === await realpath(process.argv[1])) {
  try { console.log(JSON.stringify(await checkSizeStep(resolve(process.argv[2] ?? '.')))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
