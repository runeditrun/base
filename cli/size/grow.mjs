import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { RerError, invalid } from '../errors.mjs';
import { readSizeDeclaration, declarationFile } from './declaration.mjs';
import { resolveProject } from '../project.mjs';
import { sizes } from './fixture.mjs';
import { prepareRun, buildInstall } from './install.mjs';
import { runClock } from './clock.mjs';

const seconds = ms => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
const count = number => number.toLocaleString('en-US');

/** Whether `rer size` also builds fixtures: a size-check.json at the checkout root, or --declaration FILE. */
export const growthRequested = options => !options.statements && Boolean(options.declaration || existsSync(join(options.cwd, declarationFile)));

async function declared(options) {
 const file = options.declaration ? resolve(process.cwd(), options.declaration) : join(options.cwd, declarationFile);
 // Without OPERATIONS.json the checkout has no adapter: crons and deploy files come from the declaration's build paths.
 const project = await resolveProject(options.cwd).catch(() => undefined);
 const result = await readSizeDeclaration(options.cwd, project?.adapter, { file });
 if (!result.present) throw invalid(`No size declaration at ${file}.`);
 if (result.problems.length) throw new RerError('size_declaration_invalid', ['The size declaration has problems:', ...result.problems.map(({ path, message }) => `  SC-15.size.${path || 'declaration'}: ${message}`)].join('\n'), 1);
 return { declaration: result.declaration, project };
}

function tableLines(built) {
 return built.tables.map(({ table, declared, readBack, before, ms }) => `  ${table.padEnd(26)} declared ${count(declared).padStart(9)}   read back ${count(readBack).padStart(9)}${readBack === declared ? '' : '  DIFFERS'}${before ? ` (+${count(before)} already there from the owner bootstrap)` : ''}   ${seconds(ms)}`);
}

/**
 * The growth check's first half: a small and then a large disposable install built from the declared shape.
 * Resolves { ok, small, large } and prints each size's tables and phase times; the first failing size stops the run,
 * is printed with no "built" line, and fails it.
 */
export async function buildFixtures(options, out) {
 const { declaration, project } = await declared(options), run = await prepareRun(options.cwd, declaration, { project }), clock = runClock(declaration.budget.timeoutSeconds);
 const result = { ok: true };
 try {
  for (const size of sizes) {
   if (!options.json) out.human(`Size check (${options.declaration ? basename(options.declaration) : declarationFile}): building the ${size} fixture on local D1.`);
   try {
    const built = await buildInstall(run, size, clock);
    result[size] = { tables: built.tables.map(table => ({ ...table, ms: Math.round(table.ms) })), totalRows: built.totalRows, phasesMs: Object.fromEntries(Object.entries(built.phases).map(([phase, ms]) => [phase, Math.round(ms)])), statements: built.statements };
    if (options.json) continue;
    tableLines(built).forEach(line => out.human(line));
    const total = Object.values(built.phases).reduce((all, ms) => all + ms, 0);
    out.human(`  ${size} built in ${seconds(total)} (${Object.entries(built.phases).map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(', ')}): ${count(built.tables.length)} tables declared, ${count(built.totalRows)} rows in the database with triggers.`);
   } catch (error) {
    if (!(error instanceof RerError)) throw error;
    result.ok = false;
    result[size] = { error: error.message, code: error.code };
    if (!options.json) out.human(`  FAIL ${error.message}`);
    break;
   }
  }
 } finally { clock.stop(); }
 return result;
}
