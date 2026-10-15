import { generateKeyPairSync } from 'node:crypto';
import { loadAnchors } from './signature.mjs';
import { publicEntry, anchorSet, validity } from './signing-key.mjs';
import { writeNew } from './signing-io.mjs';

export async function keygen(options) {
  if (process.stdout.isTTY) throw new TypeError('ARGUMENT_INVALID');
  const { privateKey } = generateKeyPairSync('ed25519');
  const dates = validity(options['not-before'] ? new Date(options['not-before']) : new Date());
  const entry = await publicEntry(privateKey, { scope: options.scope, publisher: options.publisher,
    githubOwner: { login: options['github-owner'], id: Number(options['github-owner-id']) },
    notBefore: options['not-before'] ?? dates.notBefore, notAfter: options['not-after'] ?? dates.notAfter,
    unsignedThrough: options.unsignedThrough });
  const anchors = anchorSet(entry, options.scope);
  await loadAnchors(anchors, anchors.environment);
  writeNew(options['anchor-out'], JSON.stringify(entry, null, 2) + '\n');
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
