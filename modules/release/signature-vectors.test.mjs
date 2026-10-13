import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Refusal, loadAnchors, verifyRelease } from './signature.mjs';

const vectors = JSON.parse(readFileSync(new URL('./vectors/release-signature-vectors.json', import.meta.url), 'utf8'));

test('public release-signature conformance vectors match the verifier', async () => {
  for (const vector of vectors) {
    let actual;
    try {
      const { minimumSerial, ...verifyContext } = vector.context;
      const options = minimumSerial === undefined
        ? {}
        : { minimumSerial };
      const loaded = await loadAnchors(vector.anchors, vector.context.environment, options);
      if (vector.envelope === null) {
        actual = 'ANCHORS_LOADED';
      } else {
        const envelope = vector.envelope === false
          ? null
          : new Uint8Array(Buffer.from(vector.envelope, 'base64'));
        const context = { ...verifyContext };
        if (context.files) {
          context.files = new Map(Object.entries(context.files)
            .map(([path, content]) => [path, new Uint8Array(Buffer.from(content, 'base64'))]));
        }
        actual = (await verifyRelease(envelope, loaded, context)).verdict;
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      actual = error.code;
    }
    assert.equal(actual, vector.expected, vector.name);
  }
});
