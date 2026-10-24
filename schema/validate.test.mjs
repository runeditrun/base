// node --test schema/validate.test.mjs
//
// Two things are under test: the schemas say what a release and a manifest must
// contain, and json-schema.mjs actually enforces it. The probes are written as JSON
// text rather than object literals so that keys like `__proto__` reach the validator
// the way a real file does — as own properties created by JSON.parse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkSchema, validate } from './json-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));
const releaseSchema = read('RELEASE.schema.json');

// A minimal release that validates, as text. Probes edit it and stay invalid for
// exactly one reason.
const RELEASE = `{
  "version": "0.2.0",
  "previousVersion": "0.1.0",
  "date": "2026-09-07",
  "contractChanges": {
    "HOME-001": {
      "change": "added",
      "summary": "Defines the deployment owner's public identity plate at /."
    }
  },
  "extensionPointChanges": [],
  "migrations": [],
  "breaking": false,
  "agentUpdateInstructions": "Keep the owner plate sourced only from src/ext/config.ts."
}`;

const withRoot = (json) => RELEASE.replace('{', `{${json},`);
const withClause = (json) => RELEASE.replace('"HOME-001": {', `"HOME-001": {${json},`);

test('the release schema states only rules the validator enforces', () => {
  assert.doesNotThrow(() => checkSchema(releaseSchema));
});

test('the minimal release and the worked example validate', () => {
  assert.deepEqual(validate(releaseSchema, JSON.parse(RELEASE)), []);
  assert.deepEqual(validate(releaseSchema, read('RELEASE.example.json')), []);
});

const releaseProbes = [
  // Prototype keys: an own property named after something on Object.prototype is
  // a property like any other, and additionalProperties: false rejects it.
  ['a prototype key at the top level', withRoot('"toString": "x"'), 'unknown property "toString"'],
  ['a prototype key inside a clause', withClause('"valueOf": "x"'), 'unknown property "valueOf"'],
  ['a __proto__ key at the top level', withRoot('"__proto__": {"version": "9.9.9"}'), 'unknown property "__proto__"'],
  ['a __proto__ key inside a clause', withClause('"__proto__": {"change": "removed"}'), 'unknown property "__proto__"'],
  ['a constructor key at the top level', withRoot('"constructor": "x"'), 'unknown property "constructor"'],

  ['a missing required field', RELEASE.replace(/,\n  "agentUpdateInstructions".*\n/, '\n'), 'missing required property "agentUpdateInstructions"'],
  ['an unknown top-level field', withRoot('"notes": "x"'), 'unknown property "notes"'],
  ['a clause key that is not a clause ID', RELEASE.replace('"HOME-001"', '"home-1"'), 'property name "home-1" does not match'],
  ['a changed clause with no was/now', withClause('"was": null').replace('"change": "added"', '"change": "changed"'), 'expected string, got null'],
  ['a changed clause missing was', RELEASE.replace('"change": "added"', '"change": "changed"'), 'missing required property "was"'],
  ['an impossible date', RELEASE.replace('"2026-09-07"', '"2026-02-30"'), 'is not a YYYY-MM-DD date'],
  ['an empty summary', RELEASE.replace(/"summary": "[^"]*"/, '"summary": ""'), 'must not be empty'],
  ['a version that is not semver', RELEASE.replace('"0.2.0"', '"v0.2"'), 'does not match'],

  // proseChanges: a first release has no previous version to have changed from.
  ['a prose change on a first release', withRoot('"proseChanges": []').replace(/,\n  "previousVersion": "0.1.0"/, ''), 'missing required property "previousVersion"'],
  ['a changed document with no was', withRoot('"proseChanges": [{"document": "AGENTS.md", "change": "changed", "date": "2026-09-06", "summary": "s", "now": "n"}]'), 'missing required property "was"'],
  ['an added document with no now', withRoot('"proseChanges": [{"document": "LICENSE", "change": "added", "date": "2026-09-06", "summary": "s"}]'), 'missing required property "now"'],
  ['a prose change with no kind', withRoot('"proseChanges": [{"document": "LICENSE", "date": "2026-09-06", "summary": "s", "now": "n"}]'), 'missing required property "change"']
];

for (const [name, text, expected] of releaseProbes) {
  test(`rejects ${name}`, () => {
    const errors = validate(releaseSchema, JSON.parse(text));
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `expected an error containing ${JSON.stringify(expected)}, got ${JSON.stringify(errors)}`
    );
  });
}

// The manifest. Same method, and the probes name the shapes the written manifests
// actually disagree on, so the schema's choices stay tested rather than asserted.
const seedSchema = read('SEED.schema.json');

const SEED = `{
  "id": "slate",
  "name": "Slate",
  "version": "0.1.0",
  "maturity": "foundation-checkpoint",
  "category": "knowledge",
  "spine": { "id": "knowledge", "record": "a page in a tree in a container" },
  "replaces": [{ "name": "Notion", "edition": null }],
  "description": "A self-hosted knowledge workspace for one business.",
  "capabilities": [{ "id": "public-landing", "clauses": ["HOME-001"] }],
  "nonGoals": ["Multiple workspaces, roles, or public share links."],
  "externals": [{
    "id": "transactional-email-provider",
    "required": true,
    "why": "Cloudflare's owned primitives do not send mail.",
    "data": ["operator email address"],
    "adapters": ["mail.sender.v1"]
  }],
  "env": [{ "name": "SESSION_SECRET", "required": true, "secret": true, "why": "Signs sessions." }],
  "deploy": { "healthPath": "/health", "publicPaths": ["/", "/signin"] },
  "extensionPoints": {
    "contributions": [],
    "policies": [],
    "events": [],
    "slots": [],
    "adapters": ["mail.sender.v1", "ai.provider.v1"]
  },
  "limits": { "status": "estimated until the load test runs" },
  "accessibility": { "level": "WCAG 2.2 AA", "status": "target until audited" },
  "operatingCost": { "status": "estimated, not measured against a deployment" }
}`;

const withSeedRoot = (json) => SEED.replace('{', `{${json},`);

test('the seed schema states only rules the validator enforces', () => {
  assert.doesNotThrow(() => checkSchema(seedSchema));
});

test('the minimal manifest and the worked example validate', () => {
  assert.deepEqual(validate(seedSchema, JSON.parse(SEED)), []);
  assert.deepEqual(validate(seedSchema, read('SEED.example.json')), []);
});

test('an edition that exists validates as readily as one that does not', () => {
  const withEdition = SEED.replace('"edition": null', '"edition": "notion"');
  assert.deepEqual(validate(seedSchema, JSON.parse(withEdition)), []);
});

const seedProbes = [
  ['a missing category', SEED.replace(/\n  "category": "knowledge",/, ''), 'missing required property "category"'],
  ['a category outside the vocabulary', SEED.replace('"knowledge"', '"knowledge-base"'), 'is not one of'],
  ['a seed id that is not a slug', SEED.replace('"id": "slate"', '"id": "Slate"'), 'does not match'],

  ['a missing spine', SEED.replace(/\n  "spine": .*\n/, '\n'), 'missing required property "spine"'],
  ['a spine that does not name its record', SEED.replace(', "record": "a page in a tree in a container"', ''), 'missing required property "record"'],
  ['a spine id that is not a slug', SEED.replace('{ "id": "knowledge"', '{ "id": "Knowledge"'), 'does not match'],

  // Replacement claims remain optional; their individual shape is still checked.
  ['a replaced product that leaves its edition unanswered', SEED.replace(', "edition": null', ''), 'missing required property "edition"'],
  ['a replaced product whose edition is neither a slug nor null', SEED.replace('"edition": null', '"edition": 2'), 'expected string or null, got integer'],
  ['a replaced product with an empty edition', SEED.replace('"edition": null', '"edition": ""'), 'must not be empty'],

  // capabilities is an ordered array of objects; seeds/confluence's map is the shape
  // this schema rejects.
  ['capabilities as a map of names to clause lists', SEED.replace('[{ "id": "public-landing", "clauses": ["HOME-001"] }]', '{ "publicLanding": ["HOME-001"] }'), 'expected array, got object'],
  ['a capability with no clauses', SEED.replace(', "clauses": ["HOME-001"]', ''), 'missing required property "clauses"'],
  ['a capability that guarantees nothing', SEED.replace('["HOME-001"]', '[]'), 'needs at least 1 item(s)'],
  ['a clause that is not a clause ID', SEED.replace('"HOME-001"', '"home-1"'), 'does not match'],

  ['an unknown top-level field', withSeedRoot('"identity": "x"'), 'unknown property "identity"'],
  ['custom fields as a shape rather than a list of entities', withSeedRoot('"customFields": { "entities": ["eventType"] }'), 'expected array, got object'],

  ['an external that does not say whether it is required', SEED.replace('"required": true,\n    "why"', '"why"'), 'missing required property "required"'],
  ['an external that does not say whether it can be replaced', SEED.replace(',\n    "adapters": ["mail.sender.v1"]', ''), 'missing required property "adapters"'],
  ['an external that sends unnamed data', SEED.replace('["operator email address"]', '"the operator\'s email address"'), 'expected array, got string'],

  ['an env variable name that is not upper snake case', SEED.replace('"SESSION_SECRET"', '"session_secret"'), 'does not match'],
  ['an env variable with no stated reason', SEED.replace(', "why": "Signs sessions."', ''), 'missing required property "why"'],

  ['a public path that is not a path', SEED.replace('"/signin"', '"signin"'), 'does not match'],
  ['an extension surface missing one of the five concepts', SEED.replace(/\n    "slots": \[\],/, ''), 'missing required property "slots"'],
  ['an extension ID with no version', SEED.replace('"ai.provider.v1"', '"ai.provider"'), 'does not match'],

  // limits and operatingCost are otherwise open: only the honesty of the claim is
  // a rule a schema can carry.
  ['limits that do not say whether they were measured', SEED.replace('{ "status": "estimated until the load test runs" }', '{ "operatorsPerDeployment": 25 }'), 'missing required property "status"'],
  ['an operating cost that does not say whether it was measured', SEED.replace('{ "status": "estimated, not measured against a deployment" }', '{ "currency": "USD" }'), 'missing required property "status"'],
  ['an accessibility level with no status', SEED.replace(', "status": "target until audited"', ''), 'missing required property "status"']
];

for (const [name, text, expected] of seedProbes) {
  test(`the manifest rejects ${name}`, () => {
    const errors = validate(seedSchema, JSON.parse(text));
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `expected an error containing ${JSON.stringify(expected)}, got ${JSON.stringify(errors)}`
    );
  });
}

test('required is satisfied only by own properties', () => {
  const own = { type: 'object', required: ['constructor'], properties: {}, additionalProperties: false };
  assert.deepEqual(validate(own, JSON.parse('{}')), ['$: missing required property "constructor"']);
});

// The schema walk. validate only sees the subschemas a document reaches, so these
// unsupported keywords are invisible to it and have to be caught before any
// document is read.
test('an unsupported keyword in an unused $def throws', () => {
  const probe = {
    type: 'object',
    properties: { a: { type: 'string' } },
    $defs: { unused: { type: 'object', maxProperties: 1 } }
  };
  assert.deepEqual(validate(probe, { a: 'x' }), [], 'validate cannot see an unused $def');
  assert.throws(() => checkSchema(probe), /unsupported schema keyword "maxProperties" at #\/\$defs\/unused/);
});

test('an unsupported keyword on an absent property throws', () => {
  const probe = { type: 'object', properties: { absent: { type: 'string', maxLength: 3 } } };
  assert.deepEqual(validate(probe, {}), [], 'validate cannot see a property no document carries');
  assert.throws(() => checkSchema(probe), /unsupported schema keyword "maxLength" at #\/properties\/absent/);
});

test('an unsupported keyword in an untaken conditional branch throws', () => {
  const probe = {
    type: 'object',
    allOf: [{
      if: { required: ['kind'], properties: { kind: { const: 'a' } } },
      then: { type: 'object', minProperties: 2 }
    }]
  };
  assert.deepEqual(validate(probe, { kind: 'b' }), [], 'validate cannot see a branch the document does not take');
  assert.throws(() => checkSchema(probe), /unsupported schema keyword "minProperties"/);
  assert.throws(() => checkSchema({not: {minProperties: 1}}), /unsupported schema keyword "minProperties" at #\/not/);
});

test('an unsupported format anywhere in the schema throws', () => {
  const probe = { type: 'object', properties: { site: { type: 'string', format: 'uri' } } };
  assert.throws(() => checkSchema(probe), /unsupported format "uri" at #\/properties\/site/);
});

// A union type, which `replaces[].edition` needs: a slug, or explicitly nothing.
test('a union type accepts either member and nothing else', () => {
  const probe = { type: ['string', 'null'], minLength: 1 };
  assert.deepEqual(validate(probe, JSON.parse('null')), []);
  assert.deepEqual(validate(probe, 'notion'), []);
  assert.deepEqual(validate(probe, JSON.parse('2')), ['$: expected string or null, got integer']);
  assert.deepEqual(validate(probe, ''), ['$: must not be empty'], 'the string keywords still apply to the string member');
});

test('a type name the validator does not know throws, in either form', () => {
  assert.throws(() => checkSchema({ type: 'strng' }), /unsupported type "strng" at #/);
  const union = { type: 'object', properties: { edition: { type: ['string', 'nul'] } } };
  assert.deepEqual(validate(union, JSON.parse('{"edition": null}')), ['$.edition: expected string or nul, got null']);
  assert.throws(() => checkSchema(union), /unsupported type "nul" at #\/properties\/edition/);
});


test('release authors can declare structured shots and invalid galleries are refused', () => {
  const release = JSON.parse(RELEASE);
  const shot = { path: 'shots/workbench.webp', alt: 'The workbench', caption: 'Current work.', width: 1600, height: 1000 };
  release.screenshots = [shot];
  assert.deepEqual(validate(releaseSchema, release), []);
  release.screenshots = Array.from({ length: 6 }, (_, i) => ({ ...shot, path: `shots/workbench-${i}.webp` }));
  assert.ok(validate(releaseSchema, release).length > 0);
  release.screenshots = [{ path: 'shots/incomplete.webp' }];
  assert.ok(validate(releaseSchema, release).length > 0);
});
