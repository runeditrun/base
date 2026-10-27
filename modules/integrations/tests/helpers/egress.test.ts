import { runCases, type Case } from '../cases.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { declareEgress, validateEgressConfiguration } from '../../egress/index.ts';

const repositoryRoot = process.cwd();
const exampleSeed = JSON.parse(readFileSync(resolve(repositoryRoot, 'schema/SEED.example.json'), 'utf8')) as Record<string, any>;

function declaration() {
  return declareEgress({
    id: 'customer-webhook',
    required: false,
    requiredWhen: 'CUSTOMER_WEBHOOK_ENABLED=true',
    provider: { id: 'customer-webhook', name: 'Customer webhook receiver' },
    destination: { kind: 'custom', id: 'customer-events', description: "the customer's configured event receiver" },
    why: 'A customer-owned receiver processes events outside this deployment.',
    dataFields: ['event name', 'delivery ID', 'approved event payload'],
    adapters: ['integrations.webhook.v1'],
    custody: [{ name: 'CUSTOMER_WEBHOOK_SIGNING_KEY', purpose: 'signs exact webhook request bytes' }],
  });
}

test("egress declarations preserve explicit custody and refuse mismatched or unsafe configuration", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['projects explicit provider, custom destination, data and secret custody to actual SEED fields', () => {
  const result = declaration();
  assert.deepEqual(Object.keys(result.external).sort(), ['adapters', 'data', 'id', 'required', 'requiredWhen', 'why']);
  assert.match(result.external.why, /Customer webhook receiver \(customer-webhook\)/);
  assert.match(result.external.why, /custom destination customer-events/);
  assert.deepEqual(result.external.data, ['event name', 'delivery ID', 'approved event payload']);
  assert.deepEqual(result.env, [{
    name: 'CUSTOMER_WEBHOOK_SIGNING_KEY',
    required: false,
    requiredWhen: 'CUSTOMER_WEBHOOK_ENABLED=true',
    secret: true,
    why: 'signs exact webhook request bytes for Customer webhook receiver; load from server-side secret storage and never expose to browser code or logs.',
  }]);
  assert.deepEqual(result.route.destination, {
    kind: 'custom',
    id: 'customer-events',
    description: "the customer's configured event receiver",
  });
  assert.deepEqual(result.route.custody, [{
    name: 'CUSTOMER_WEBHOOK_SIGNING_KEY',
    purpose: 'signs exact webhook request bytes',
    store: 'server-secret-store',
  }]);
  assert.equal('provider' in result.external, false);
  assert.equal('destination' in result.external, false);
  assert.equal('custody' in result.external, false);
}]);
foldedCases.push(['validates configured egress against its declaration and core destination policy', () => {
  const result = declaration();
  const validated = validateEgressConfiguration(result, {
    providerId: 'customer-webhook',
    destinationId: 'customer-events',
    destinationUrl: 'https://hooks.example.com/events',
    secrets: { CUSTOMER_WEBHOOK_SIGNING_KEY: 'base64-signing-key' },
  });
  assert.deepEqual(validated, {
    providerId: 'customer-webhook',
    destinationId: 'customer-events',
    destinationUrl: 'https://hooks.example.com/events',
  });
  assert.equal(Object.isFrozen(validated), true);
}]);
foldedCases.push(['rejects route drift, missing credentials and unsafe or malformed destinations', async (t) => {
  const result = declaration();
  const config = {
    providerId: 'customer-webhook',
    destinationId: 'customer-events',
    destinationUrl: 'https://hooks.example.com/events',
    secrets: { CUSTOMER_WEBHOOK_SIGNING_KEY: 'base64-signing-key' },
  };
  await runCases(t, [
    ["configuration refusal inputs: case 1", async t => {
      assert.throws(() => validateEgressConfiguration(result, { ...config, providerId: 'other-provider' }), /provider does not match/);
    }],
    ["configuration refusal inputs: case 2", async t => {
      assert.throws(() => validateEgressConfiguration(result, { ...config, destinationId: 'other-destination' }), /destination does not match/);
    }],
    ["configuration refusal inputs: case 3", async t => {
      assert.throws(() => validateEgressConfiguration(result, { ...config, secrets: {} }), /CUSTOMER_WEBHOOK_SIGNING_KEY/);
    }],
    ["configuration refusal inputs: case 4", async t => {
      assert.throws(() => validateEgressConfiguration(result, {
    ...config,
    secrets: { CUSTOMER_WEBHOOK_SIGNING_KEY: 'bad\nheader' },
  }), /CUSTOMER_WEBHOOK_SIGNING_KEY/);
    }]
  ]);
  await runCases(t, Array.from([
    'http://hooks.example.com/events',
    'https://localhost/events',
    'https://127.0.0.1/events',
    'https://user:test-password@hooks.example.com/events',
    'not a URL',
  ], (destinationUrl, rowIndex) => [`${t.name}: destinationUrl row ${rowIndex + 1}`, async t => {
    assert.throws(() => validateEgressConfiguration(result, { ...config, destinationUrl }), /Invalid public HTTPS egress destination/);
}]));
}]);
foldedCases.push(['rejects incomplete declarations before they can become external promises', async (t) => {
  await runCases(t, [
    ["incomplete declaration inputs: case 1", async t => {
      assert.throws(() => declareEgress({
    id: 'custom-hook',
    required: false,
    provider: { id: 'custom-hook', name: 'Custom receiver' },
    destination: { kind: 'custom', id: 'events', description: 'event receiver' },
    why: 'A custom receiver processes external events.',
    dataFields: [],
    adapters: ['integrations.webhook.v1'],
    custody: [],
  }), /requiredWhen/);
    }],
    ["incomplete declaration inputs: case 2", async t => {
      assert.throws(() => declareEgress({
    id: 'custom-hook',
    required: true,
    provider: { id: 'custom-hook', name: 'Custom receiver' },
    destination: { kind: 'custom', id: 'events', description: 'event receiver' },
    why: 'A custom receiver processes external events.',
    dataFields: ['event name'],
    adapters: ['not-a-versioned-adapter'],
    custody: [],
  }), /adapter IDs/);
    }],
    ["incomplete declaration inputs: case 3", async t => {
      assert.throws(() => declareEgress({
    id: 'custom-hook',
    required: true,
    provider: { id: 'custom-hook', name: 'Custom receiver' },
    destination: { kind: 'custom', id: 'events', description: 'event receiver' },
    why: 'A custom receiver processes external events.',
    dataFields: ['event name'],
    adapters: ['integrations.webhook.v1'],
    custody: [{ name: 'not_an_ENV', purpose: 'signs event body' }],
  }), /secret declaration/);
    }]
  ]);
}]);
foldedCases.push(['represents a non-replaceable external with the schema-supported empty adapters list', () => {
  const nonReplaceable = declareEgress({
    id: 'customer-webhook',
    required: true,
    provider: { id: 'customer-webhook', name: 'Customer webhook receiver' },
    destination: { kind: 'custom', id: 'customer-events', description: "the customer's configured event receiver" },
    why: 'A customer-owned receiver processes events outside this deployment.',
    dataFields: ['event name'],
    adapters: [],
    custody: [],
  });
  assert.deepEqual(nonReplaceable.external.adapters, []);
}]);
foldedCases.push(['positive and negative declaration controls run through Base SEED validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 't060-egress-seed-'));
  const target = join(dir, 'seed.json');
  try {
    const valid = structuredClone(exampleSeed);
    const result = declaration();
    valid.externals.push(result.external);
    valid.env.push(...result.env);
    writeFileSync(target, JSON.stringify(valid));
    const positive = spawnSync(process.execPath, ['schema/validate.mjs', '--schema', 'SEED', target], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    assert.match(positive.stdout, /1\/1 valid against schema\/SEED\.schema\.json/);

    const extraProperty = structuredClone(valid);
    extraProperty.externals.at(-1).provider = 'fictional-schema-field';
    writeFileSync(target, JSON.stringify(extraProperty));
    const propertyNegative = spawnSync(process.execPath, ['schema/validate.mjs', '--schema', 'SEED', target], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.notEqual(propertyNegative.status, 0, propertyNegative.stdout);
    assert.match(propertyNegative.stderr, /additional properties|provider/i);

    const dataNegative = structuredClone(valid);
    dataNegative.externals.at(-1).data = [];
    writeFileSync(target, JSON.stringify(dataNegative));
    const dataNegativeResult = spawnSync(process.execPath, ['schema/validate.mjs', '--schema', 'SEED', target], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.notEqual(dataNegativeResult.status, 0, dataNegativeResult.stdout);
    assert.match(dataNegativeResult.stderr, /minItems|data/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}]);
  await runCases(t, foldedCases);
});
