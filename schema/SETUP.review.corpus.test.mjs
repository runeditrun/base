import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkSchema, validate as validateJsonSchema} from './json-schema.mjs';
import {setupManifestSemanticErrors, validateSetupManifest} from './setup-validation.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const schema = read('SETUP.schema.json');
const reviewSource = readFileSync(new URL('SETUP.review.test.mjs', import.meta.url), 'utf8');
const reviewTestPath = fileURLToPath(new URL('SETUP.review.test.mjs', import.meta.url));
const baseDirectory = fileURLToPath(new URL('..', import.meta.url));

function emittedReviewTestNames() {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', reviewTestPath
  ], {cwd: baseDirectory, encoding: 'utf8', env});
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = `${run.stdout}\n${run.stderr}`;
  const tests = [...output.matchAll(/^ok \d+ - (.*)$/gm)].map(match => match[1]);
  // Table rows are not registrations. Their labels are emitted only after the
  // row's assertions finish, so a source label alone cannot establish coverage.
  const cases = [...output.matchAll(/^# SETUP_REVIEW_CASE (".*")$/gm)].map(match => JSON.parse(match[1]));
  return new Set([...tests, ...cases]);
}

function reviewRejectionNames(testNames) {
  const lines = reviewSource.split('\n');
  const rejectionTitles = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\binvalid\(data\)|validateSetupManifest\(schema,data\)\.some\(/.test(lines[index])) continue;
    let declaration = index;
    while (declaration >= 0 && !/\b(?:test|manifestCase)\(\s*['"`]/.test(lines[declaration])) declaration -= 1;
    assert(declaration >= 0, `rejection assertion on line ${index + 1} must be inside a named test`);
    const titleMatch = lines[declaration].match(/\b(?:test|manifestCase)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    assert(titleMatch, `could not read review test title on line ${declaration + 1}`);
    const titleExpression = titleMatch[2];
    const fragments = titleExpression.split(/\$\{[^}]*\}/);
    const titlePattern = new RegExp(`^${fragments.map(escapeRegExp).join('.*')}$`);
    const matches = [...testNames].filter(name => titlePattern.test(name));
    assert(matches.length > 0, `no emitted review test matches ${titleExpression}: ${titlePattern} in ${[...testNames].slice(0, 5).join(' | ')}`);
    for (const name of matches) rejectionTitles.add(name);
  }
  return rejectionTitles;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyOperations(base, operations) {
  const data = structuredClone(base);
  for (const operation of operations ?? []) {
    let target = data;
    for (const key of operation.path.slice(0, -1)) target = target[key];
    const key = operation.path.at(-1);
    if (operation.op === 'delete') delete target[key];
    else target[key] = structuredClone(operation.value);
  }
  return data;
}

test('every current review manifest rejection has a portable source-linked case', () => {
  const corpus = read('setup-review-negative-corpus.json');
  checkSchema(schema);
  const testNames = emittedReviewTestNames();
  const expectedNames = reviewRejectionNames(testNames);
  const entries = new Map();

  for (const entry of corpus.cases) {
    assert.equal(entry.origin, 'review', entry.name);
    assert.equal(entry.source?.file, 'SETUP.review.test.mjs', entry.name);
    assert.equal(entry.source?.test, entry.name, entry.name);
    assert(expectedNames.has(entry.source.test), `source test is not a current rejection: ${entry.name}`);
    assert(!entries.has(entry.source.test), `duplicate source test: ${entry.name}`);
    entries.set(entry.source.test, entry);

    const data = applyOperations(corpus.base, entry.operations);
    const structuralErrors = validateJsonSchema(schema, data);
    const semanticErrors = setupManifestSemanticErrors(data);
    const baseErrors = validateSetupManifest(schema, data);
    assert(baseErrors.length > 0, `Base validator accepted ${entry.name}`);
    if (entry.errorIncludes) {
      assert(baseErrors.some(error => error.includes(entry.errorIncludes)), entry.name);
    }

    if (entry.validation === 'schema') {
      assert(structuralErrors.length > 0, `${entry.name} must fail the structural schema check`);
      assert.deepEqual(baseErrors, structuralErrors, entry.name);
    } else {
      assert.equal(entry.validation, 'semantic', `${entry.name} must name its validation layer`);
      assert.deepEqual(structuralErrors, [], `${entry.name} must remain structurally valid`);
      assert(semanticErrors.length > 0, `${entry.name} must fail semantic validation`);
      assert.deepEqual(baseErrors, semanticErrors, entry.name);
    }
  }

  assert.deepEqual([...entries.keys()].sort(), [...expectedNames].sort(),
    'portable review cases must cover exactly the current review rejection tests');
});
