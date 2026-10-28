import {checkCases} from './test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {checkSchema} from './json-schema.mjs';
import {parseSetupManifestBytes, validateSetupManifest} from './setup-validation.mjs';

const manifestCases = [];
const manifestCase = (name, check) => manifestCases.push([name, check]);

const here = dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(readFileSync(join(here, name), 'utf8'));
const schema = read('SETUP.schema.json');
const example = read('SETUP.example.json');

manifestCase('setup schema is enforced and the positive example covers every public kind and metadata family', () => {
  assert.doesNotThrow(() => checkSchema(schema));
  assert.deepEqual(validateSetupManifest(schema, example), []);
  assert.deepEqual(
    [...new Set(example.fields.filter(field => field.kind !== 'secret').map(field => field.kind))].sort(),
    ['colour', 'email', 'select', 'text', 'timezone', 'url']
  );
  assert(example.groups.some(group => group.help && group.presentations?.length));
  assert(example.fields.some(field => field.order !== undefined));
  assert(example.fields.some(field => field.presentations?.some(presentation => presentation.order !== undefined)));
  assert(example.fields.some(field => field.when));
  assert(example.fields.some(field => field.prefill === 'account-email'));
  assert(example.fields.some(field => field.kind === 'secret' && field.generate === 'hex'));
  assert(example.fields.some(field => field.kind === 'secret' && field.generate === 'base64'));
  assert(example.fields.some(field => field.kind === 'secret' && field.required === false));
  assert(example.fields.some(field => field.runtimeEditable === true));
  assert.deepEqual(example.steps.filter(step => step.type === 'owner-claim').length, 1);
});

const invalidCases = [
  ['unsupported version', data => { data.schema = 2; }],
  ['unknown root property', data => { data.future = true; }],
  ['unknown field property', data => { data.fields[1].future = true; }],
  ['duplicate field name', data => { data.fields[1].name = data.fields[0].name; }],
  ['duplicate group ID', data => { data.groups[1].id = data.groups[0].id; }],
  ['unknown group reference', data => { data.fields[1].group = 'missing'; }],
  ['unsupported public kind', data => { data.fields[1].kind = 'color'; }],
  ['duplicate select value', data => { data.fields[0].options[1].value = data.fields[0].options[0].value; }],
  ['select default without an option', data => { data.fields[0].default = 'unlisted'; }],
  ['options on non-select field', data => { data.fields[1].options = [{value:'x',label:'X'}]; }],
  ['condition references a missing field', data => { data.fields.find(field => field.name === 'CUSTOM_DOMAIN').when.field = 'MISSING'; }],
  ['condition references a later field', data => { data.fields[0].when = {field:'APP_NAME',equals:'Northstar'}; }],
  ['condition references a secret field', data => { data.fields.find(field => field.name === 'APP_NAME').when = {field:'EMAIL_API_KEY',equals:'key'}; }],
  ['condition uses a missing select value', data => { data.fields.find(field => field.name === 'EMAIL_FROM').presentations[0].when.equals = 'missing'; }],
  ['presentation variants can overlap', data => { data.fields.find(field => field.name === 'EMAIL_FROM').presentations[1].when.equals = 'resend'; }],
  ['presentation discriminator differs', data => { data.fields.find(field => field.name === 'EMAIL_FROM').presentations[1].when.field = 'DEPLOYMENT_MODE'; }],
  ['account-email prefill on non-email field', data => { data.fields.find(field => field.name === 'DEPLOYMENT_MODE').prefill = 'account-email'; }],
  ['invalid secret generator', data => { data.fields.find(field => field.name === 'OWNER_CLAIM_TOKEN').generate = 'random'; }],
  ['owner-visible secret without generation', data => { data.fields.find(field => field.name === 'OPTIONAL_PROVIDER_KEY').ownerVisible = true; }],
  ['missing owner-claim step', data => { data.steps = data.steps.filter(step => step.type !== 'owner-claim'); }],
  ['multiple owner-claim steps', data => { data.steps.push(structuredClone(data.steps[0])); }],
  ['claim email does not reference prefilled email', data => { data.steps[0].emailField = 'APP_NAME'; }],
  ['signed claim uses visible secret', data => { data.fields.find(field => field.name === 'OWNER_CLAIM_TOKEN').ownerVisible = true; }],
  ['signed claim token is optional', data => { data.fields.find(field => field.name === 'OWNER_CLAIM_TOKEN').required = false; }],
  ['signed claim path is not same-app safe', data => { data.steps[0].path = '//other.example/claim'; }],
  ['legacy claim token is not owner-visible', data => { data.steps[0].mode = 'setup-token'; delete data.steps[0].path; }],
  ['legacy claim token is optional', data => { data.steps[0].mode = 'setup-token'; delete data.steps[0].path; data.fields.find(field => field.name === 'OWNER_CLAIM_TOKEN').required = false; }],
  ['legacy claim declares signed path', data => { data.steps[0].mode = 'setup-token'; }]
];

for (const [name, mutate] of invalidCases) {
  manifestCase(`rejects ${name}`, () => {
    const candidate = structuredClone(example);
    mutate(candidate);
    assert(validateSetupManifest(schema, candidate).length > 0);
  });
}

manifestCase('legacy setup-token may omit its token field or reference a generated owner-visible token', () => {
  const withoutToken = structuredClone(example);
  withoutToken.steps[0] = {type:'owner-claim', mode:'setup-token', emailField:'OWNER_EMAIL'};
  assert.deepEqual(validateSetupManifest(schema, withoutToken), []);

  const withToken = structuredClone(withoutToken);
  withToken.fields.find(field => field.name === 'OWNER_CLAIM_TOKEN').ownerVisible = true;
  withToken.steps[0].tokenField = 'OWNER_CLAIM_TOKEN';
  assert.deepEqual(validateSetupManifest(schema, withToken), []);
});

manifestCase('safe same-app signed paths retain dot-prefixed and tilde segments', () => {
  const candidate = structuredClone(example);
  candidate.steps[0].path = '/.well-known/~/claim';
  assert.deepEqual(validateSetupManifest(schema, candidate), []);
});

manifestCase('extension IDs remain edition-owned data and may be repeated', () => {
  const candidate = structuredClone(example);
  candidate.steps.push({type: 'extension', id: 'email'});
  assert.deepEqual(validateSetupManifest(schema, candidate), []);
});

test('strict byte parser rejects duplicate JSON keys and invalid UTF-8', () => {
  assert.throws(() => parseSetupManifestBytes(Buffer.from('{"schema":1,"schema":1}')), /duplicate JSON field/);
  assert.throws(() => parseSetupManifestBytes(Buffer.from([0xff, 0xfe])), /valid UTF-8/);
});

manifestCase('the checked negative example is rejected by the same setup validator', () => {
  const negative = read('SETUP.invalid.example.json');
  assert(validateSetupManifest(schema, negative).some(error => error.includes('required generated hidden secret')));
});

test('expected-invalid CLI mode rejects a missing negative example path', () => {
  const result = spawnSync(process.execPath, [
    join(here, 'validate.mjs'),
    '--schema', 'SETUP',
    '--expect-invalid',
    'schema/missing.invalid.example.json'
  ], {cwd: join(here, '..'), encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL schema\/missing\.invalid\.example\.json/);
  assert.match(result.stderr, /ENOENT/);
});

test('setup manifests accept supported inputs and refuse invalid configurations', () => checkCases(manifestCases));
