import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { RerError, invalid } from '../errors.mjs';
import { readSizeDeclaration, declarationFile } from './declaration.mjs';
import { resolveProject } from '../project.mjs';
import { sizes } from './fixture.mjs';
import { prepareRun, buildInstall } from './install.mjs';
import { runClock } from './clock.mjs';
import { measureInstall } from './measure.mjs';
import { judgeFlows, statementsFile, verdictLines } from './verdict.mjs';
import { schemasFromBuild } from './schema.mjs';

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

const fixturePhases = ['serve', 'owner', 'generate', 'after', 'readback'];
const phaseText = phases => Object.entries(phases).map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(', ');

/**
 * The growth check: a small and then a large disposable install built from the declared shape, every declared flow
 * run on each through the rows-read meter, and the verdicts. Resolves { ok, small, large, flows } and prints each
 * size's tables, phase times and then the flows; the first failing size stops the run, is printed with no "built"
 * line, and fails it. `--write-statements DIR` writes the statements each size ran.
 */
export async function buildFixtures(options, out) {
 const { declaration, project } = await declared(options), run = await prepareRun(options.cwd, declaration, { project }), clock = runClock(declaration.budget.timeoutSeconds);
 const result = { ok: true }, measured = {};
 if (!options.json) out.human('Size check: queues are held while the flows run; queue consumer work is not measured.');
 try {
  for (const size of sizes) {
   if (!options.json) out.human(`Size check (${options.declaration ? basename(options.declaration) : declarationFile}): building the ${size} fixture on local D1.`);
   try {
    const built = await buildInstall(run, size, clock, measureInstall(run));
    measured[size] = built.measured;
    const phasesMs = Object.fromEntries(Object.entries(built.phases).map(([phase, ms]) => [phase, Math.round(ms)]));
    result[size] = { tables: built.tables.map(table => ({ ...table, ms: Math.round(table.ms) })), totalRows: built.totalRows, phasesMs, statements: built.statements };
    if (options.json) continue;
    tableLines(built).forEach(line => out.human(line));
    const fixture = Object.fromEntries(fixturePhases.map(phase => [phase, built.phases[phase]])), total = Object.values(fixture).reduce((all, ms) => all + ms, 0);
    out.human(`  ${size} built in ${seconds(total)} (${phaseText(fixture)}): ${count(built.tables.length)} tables declared, ${count(built.totalRows)} rows in the database with triggers.`);
    out.human(`  ${size} measured in ${seconds(built.phases.personas + built.phases.flows)} (personas ${seconds(built.phases.personas)}, flows ${seconds(built.phases.flows)}): ${count(measured[size].length)} flows run.`);
   } catch (error) {
    if (!(error instanceof RerError)) throw error;
    result.ok = false;
    result[size] = { error: error.message, code: error.code };
    if (!options.json) out.human(`  FAIL ${error.message}`);
    break;
   }
  }
 } finally { clock.stop(); }
 if (!result.ok) return result;
 const verdict = judgeFlows(declaration, measured.small, measured.large, await schemasFromBuild(options.cwd));
 result.ok = verdict.ok;
 result.flows = verdict.flows;
 result.queueConsumersMeasured = false;
 if (!options.json) verdictLines(verdict, declaration).forEach(line => out.human(line));
 if (options.writeStatements) {
  const directory = resolve(process.cwd(), options.writeStatements);
  await mkdir(directory, { recursive: true });
  for (const size of sizes) await writeFile(join(directory, `${size}.json`), JSON.stringify(statementsFile(size, measured[size]), null, 1) + '\n');
  if (!options.json) out.human(`  Wrote the statements each size ran to ${join(directory, 'small.json')} and ${join(directory, 'large.json')}.`);
 }
 return result;
}
