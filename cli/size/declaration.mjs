import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RerError } from '../errors.mjs';
import { buildFacts, defaultBuild } from './build-facts.mjs';
import { duplicateKeys } from './json-duplicates.mjs';
import { validateFlows, validatePersonas } from './validate-flows.mjs';
import { validateShape } from './validate-shape.mjs';
import { integer, isInt, isObject, keyed, pathProblem, problems } from './validate-kit.mjs';

export const declarationFile = 'size-check.json';
export const budgetDefaults = { growthPercent: 10, growthRows: 200, timeoutSeconds: 600 };

function validateBudget(found, budget, path) {
 if (!keyed(found, budget, path, ['windowRows', 'growthPercent', 'growthRows', 'timeoutSeconds'], 'budget')) return;
 if (budget.windowRows === undefined) found.add([...path, 'windowRows'], 'is required; give the rows this seed allows in D1\'s 10-second window.');
 else integer(found, budget.windowRows, [...path, 'windowRows'], 1);
 if (budget.growthPercent !== undefined && !(typeof budget.growthPercent === 'number' && budget.growthPercent >= 0)) found.add([...path, 'growthPercent'], 'must be a number of 0 or more (the share of the small size a flow may grow by).');
 if (budget.growthRows !== undefined) integer(found, budget.growthRows, [...path, 'growthRows'], 0);
 if (budget.timeoutSeconds !== undefined) integer(found, budget.timeoutSeconds, [...path, 'timeoutSeconds'], 1);
}

function validateBuild(found, build, path) {
 if (!keyed(found, build, path, ['wrangler', 'deployDeclaration'], 'build')) return;
 for (const key of ['wrangler', 'deployDeclaration']) if (build[key] !== undefined && pathProblem(build[key])) found.add([...path, key], 'must be a path inside the checkout (no leading "/" and no "..").');
}

function validateDatabase(found, database, bindings) {
 if (database === undefined) {
  if (bindings.length > 1) found.add(['database'], `is required: the build declares several D1 bindings (${bindings.join(', ')}); name the one this check measures.`);
 } else if (typeof database !== 'string' || !database) found.add(['database'], 'must name a D1 binding.');
 else if (bindings.length && !bindings.includes(database)) found.add(['database'], `${database} is not a D1 binding the checkout declares (${bindings.join(', ')}); use one of them.`);
}

/**
 * Validates a parsed size-check.json against what the checkout declares ({ crons, bindings }, see build-facts.mjs).
 * Pure: no files, no network. Returns { problems: [{ path, message }], declaration }, where declaration is the
 * normalized form with defaults filled (undefined while there are problems).
 */
export function validateSizeDeclaration(input, { crons = [], bindings = [], duplicates = [], extra = [] } = {}) {
 const found = problems();
 for (const path of duplicates) found.add(path, `"${path.at(-1)}" appears twice; names must be unique, so rename or delete one.`);
 for (const problem of extra) found.list.push(problem);
 const top = ['schema', 'about', 'database', 'build', 'budget', 'personas', 'shape', 'flows'];
 if (!keyed(found, input, [], top, 'the file')) return { problems: found.list };
 if (input.schema !== 1) found.add(['schema'], 'must be 1.');
 if (input.about !== undefined && typeof input.about !== 'string') found.add(['about'], 'must be text saying where the counts came from.');
 if (input.build !== undefined) validateBuild(found, input.build, ['build']);
 validateDatabase(found, input.database, bindings);
 if (input.budget === undefined) found.add(['budget'], 'is required; give at least { "windowRows": N }.');
 else validateBudget(found, input.budget, ['budget']);
 const personas = validatePersonas(found, input.personas, ['personas']);
 if (input.shape === undefined) found.add(['shape'], 'is required; list the tables to generate.');
 const shape = input.shape === undefined ? undefined : validateShape(found, input.shape, ['shape']);
 const windowRows = isInt(input.budget?.windowRows, 1) ? input.budget.windowRows : undefined;
 const flows = validateFlows(found, input.flows, ['flows'], { personas, crons, windowRows });
 if (found.list.length) return { problems: found.list };
 return {
  problems: [],
  declaration: {
   schema: 1, ...(input.about === undefined ? {} : { about: input.about }),
   database: input.database ?? bindings[0] ?? null,
   build: { ...defaultBuild, ...input.build },
   budget: { ...budgetDefaults, ...input.budget },
   personas: input.personas ?? {}, shape, flows,
  },
 };
}

/** Reads and validates a seed's size-check.json (or the file `file` names). { present: false } when there is none. */
export async function readSizeDeclaration(root, adapter, { file = join(root, declarationFile) } = {}) {
 let text;
 try { text = await readFile(file, 'utf8'); }
 catch (error) {
  if (error.code === 'ENOENT') return { present: false };
  throw new RerError('size_declaration_invalid', `Cannot read ${declarationFile}. Restore it or delete it.`, 1);
 }
 let input;
 try { input = JSON.parse(text); }
 catch (error) { return { present: true, problems: [{ path: '', message: `${declarationFile} must contain valid JSON (${error.message}).` }] }; }
 const build = isObject(input) && isObject(input.build) && !pathProblem(input.build.wrangler ?? 'x') && !pathProblem(input.build.deployDeclaration ?? 'x') ? input.build : {};
 const facts = await buildFacts(root, adapter, build);
 // Unreadable crons matter only when a flow names one; an unreadable build file always does.
 const scheduled = Array.isArray(input?.flows) && input.flows.some(flow => flow?.scheduled !== undefined);
 const extra = facts.problems.filter(problem => problem.path === 'build' || scheduled);
 return { present: true, ...validateSizeDeclaration(input, { ...facts, duplicates: duplicateKeys(text), extra }) };
}
