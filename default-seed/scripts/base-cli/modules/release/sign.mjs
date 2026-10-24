import { createPrivateKey } from 'node:crypto';
import { resolve } from 'node:path';
import { loadAnchors, PAYLOAD_TYPE } from './signature.mjs';
import { readArtifact, statementFor } from './statement.mjs';
import { verifyArtifact } from './verify.mjs';
import { publicEntry, anchorSet, envelope, validity, timestamp } from './signing-key.mjs';
import { SIGNATURE_FILE, readBounded, writeNew, refuse } from './signing-io.mjs';

async function keyInput(options) {
  if (options['key-file']) return readBounded(options['key-file'], 16384);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) refuse('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function signArtifact(options) {
  let privateKey;
  try {
    const bytes = await keyInput(options);
    if (!new RegExp(['^-----BEGIN ', 'PRIVATE ', String.raw`KEY-----\r?\n[\s\S]+\r?\n-----END `, 'PRIVATE ', String.raw`KEY-----\s*$`].join('')).test(bytes.toString('ascii'))) throw new Error();
    privateKey = createPrivateKey({ key: bytes, format: 'pem', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
  } catch { refuse('SIGNATURE_INVALID'); }
  const artifact = await readArtifact(options.artifact);
  if (options.publisher !== undefined) artifact.subject.publisher = options.publisher;
  const tag = artifact.receipt.tag;
  if (artifact.receipt.status !== 'RELEASED' || !(tag?.created === true ||
    (tag?.adopted === true && tag.object === artifact.subject.tagObject))) refuse('SUBJECT_MISMATCH');
  const scope = options.scope ?? 'rer', issuedAt = timestamp(new Date());
  // This ephemeral proof checks our output, not publisher admission. The
  // consumer still needs a separately reviewed anchor with the real owner ID.
  const entry = await publicEntry(privateKey, { scope, publisher: artifact.subject.publisher,
    githubOwner: { login: artifact.subject.repository.split('/')[3], id: 1 }, ...validity(new Date(issuedAt)), issuedAt });
  const anchors = { ...anchorSet(entry, scope), schemaVersion: 2,
    keys: [{ ...entry, projects: [artifact.subject.project] }] };
  const loaded = await loadAnchors(anchors, anchors.environment);
  const statement = statementFor(artifact, entry.keyId, issuedAt, anchors.schemaVersion);
  const bytes = Buffer.from(JSON.stringify(envelope(privateKey, entry.keyId, PAYLOAD_TYPE, statement)) + '\n');
  await verifyArtifact(artifact, loaded, anchors.environment, bytes);
  const target = resolve(artifact.root, SIGNATURE_FILE);
  writeNew(target, bytes);
  const shell = value => `'${value.replace(/'/g, `'\\''`)}'`;
  return `gh release upload ${shell(statement.tag)} ${shell(target)} --repo ${shell(statement.repository.slice('https://github.com/'.length))}`;
}
