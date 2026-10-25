import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../../default-seed/node_modules/esbuild/lib/main.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  canonicalReceiptJson, createReceiptEvidencePort, signImporterVerificationReceipt,
  validateImporters, verifyImporterVerificationReceipt,
} from '../src/index.ts';
import { documentedFixture, digest, verifiedFixture } from './status/fixtures.ts';

async function fixture() {
  const existing = verifiedFixture();
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const policy = {
    environment: 'stage',
    keys: {
      stage: { publicKey: keys.publicKey, environments: ['stage'] },
      other: { publicKey: other.publicKey, environments: ['stage'] },
    },
  };
  const receipt = await signImporterVerificationReceipt(existing.payload, 'stage', keys.privateKey);
  return { ...existing, keys, policy, receipt };
}

test('public signer and verifier round trip canonical JSON independently of insertion order', async () => {
  const { receipt, policy, payload, keys } = await fixture();
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const signedAgain = await signImporterVerificationReceipt(reordered, 'stage', keys.privateKey);
  assert.equal(signedAgain.signature, receipt.signature);
  assert.equal((await verifyImporterVerificationReceipt(receipt, policy)).valid, true);
  assert.equal((await verifyImporterVerificationReceipt({ ...receipt, payload: reordered }, policy)).valid, true);
  const numericKeys = { '2': { z: 1, a: 2 }, '10': ['b', 'a'] };
  assert.equal(canonicalReceiptJson(numericKeys).indexOf('"10"') < canonicalReceiptJson(numericKeys).indexOf('"2"'), true);
  for (const lossy of [undefined, NaN, { field: undefined }, new Date(), [ , 1]]) {
    assert.throws(() => canonicalReceiptJson(lossy));
  }
});

test('verification refuses tampering, unknown or wrong keys, synthetic data and noncanonical signatures', async () => {
  const { receipt, policy, keys } = await fixture();
  const unsortedBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(receipt.payload).reverse())));
  assert.notEqual(new TextDecoder().decode(unsortedBytes), canonicalReceiptJson(receipt.payload));
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, unsortedBytes);
  const altered = [
    { ...receipt, payload: { ...receipt.payload, command: receipt.payload.command + 'x' } },
    { ...receipt, keyId: 'unknown' },
    { ...receipt, keyId: 'other' },
    { ...receipt, payload: { ...receipt.payload, synthetic: true } },
    { ...receipt, signature: Buffer.from(signature).toString('base64') },
  ];
  for (const value of altered) {
    assert.equal((await verifyImporterVerificationReceipt(value, policy)).valid, false);
  }
  for (const outsidePolicy of [{ ...policy, keys: {} }, { ...policy, environment: 'production' }]) {
    assert.equal((await verifyImporterVerificationReceipt(receipt, outsidePolicy)).valid, false);
  }
  await assert.rejects(signImporterVerificationReceipt({ ...receipt.payload, synthetic: true }, 'stage', keys.privateKey));
});

test('signed receipts must include source digest and all schema counts', async () => {
  const { receipt, policy, keys } = await fixture();
  for (const remove of [
    (payload) => { delete payload.source.sha256; },
    (payload) => { delete payload.runs.apply.byKind; },
    (payload) => { delete payload.runs.dryRun.input; },
  ]) {
    const payload = structuredClone(receipt.payload);
    remove(payload);
    const bytes = new TextEncoder().encode(canonicalReceiptJson(payload));
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)).toString('base64');
    assert.equal((await verifyImporterVerificationReceipt({ ...receipt, payload, signature }, policy)).valid, false);
  }
});

test('the evidence port admits verified only with a verifying receipt and preserves documented format', async () => {
  const f = await fixture();
  const documented = documentedFixture();
  const document = { ...f.document, importers: [...f.document.importers, ...documented.document.importers.map((row) => ({ ...row, incumbent: 'OtherDesk' }))] };
  const artifacts = new Map([...f.artifacts, ...documented.artifacts]);
  const port = createReceiptEvidencePort({ resolve: (link) => artifacts.get(link), trustedHosts: ['evidence.example.test', 'docs.example.test'] }, f.policy);
  const publish = (receipt) => {
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    artifacts.set(f.receiptLink, { url: f.receiptLink, bytes });
    Object.assign(document.importers[0].evidence, { sha256: digest(bytes), size: bytes.length });
  };
  publish(f.receipt);
  const before = structuredClone(document);
  const accepted = await validateImporters(document, port);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.issues));
  assert.equal(accepted.evidence.verifiedReceipts, 1);
  assert.deepEqual(document, before);
  publish({ ...f.receipt, keyId: 'other' });
  const refused = await validateImporters(document, port);
  assert.equal(refused.valid, false);
  assert.equal(refused.evidence.verifiedReceipts, 0);
  assert.equal((await validateImporters(documented.document, port)).valid, true);
  publish(f.receipt);
  const production = createReceiptEvidencePort(port, { ...f.policy, environment: 'production' });
  assert.equal((await validateImporters(document, production)).evidence.verifiedReceipts, 0);
});

test('Worker and Node exchange signed receipts using WebCrypto without nodejs_compat', async () => {
  const f = await fixture();
  const entry = fileURLToPath(new URL('../src/receipt/index.ts', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../src/receipt/', import.meta.url)), contents: `
      import { signImporterVerificationReceipt, verifyImporterVerificationReceipt } from ${JSON.stringify(entry)};
      export default { async fetch(request) {
        const input = await request.json();
        const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(input.publicKey), 'Ed25519', false, ['verify']);
        const policy = { environment: 'stage', keys: { stage: { publicKey, environments: ['stage'] } } };
        const accepted = await verifyImporterVerificationReceipt(input.receipt, policy);
        const refused = await verifyImporterVerificationReceipt(input.receipt, { ...policy, environment: 'production' });
        const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
        const receipt = await signImporterVerificationReceipt(input.receipt.payload, 'worker', keys.privateKey);
        return Response.json({ accepted, refused, receipt, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) });
      } };
    ` },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01' }));
  try {
    const response = await mf.dispatchFetch('https://receipt.test', {
      method: 'POST', body: JSON.stringify({ receipt: f.receipt, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', f.keys.publicKey))) }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.accepted.valid, true, JSON.stringify(result.accepted.issues));
    assert.equal(result.refused.valid, false);
    const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(result.publicKey), 'Ed25519', false, ['verify']);
    assert.equal((await verifyImporterVerificationReceipt(result.receipt, { environment: 'stage', keys: { worker: { publicKey } } })).valid, true);
  } finally {
    await mf.dispose();
  }
});
