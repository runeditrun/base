import { resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { loadAnchors, verifyRelease } from './signature.mjs';
import { readArtifact } from './statement.mjs';
import { SIGNATURE_FILE, readBounded, safePath, refuse } from './signing-io.mjs';

export async function verifyArtifact(artifact, anchors, environment, bytes, highest) {
  const expect = { ...artifact.subject };
  // V2 authenticates the publisher with the signing anchor. A project's owner
  // component is no longer evidence of its publisher namespace.
  if (anchors.schemaVersion === 2) delete expect.publisher;
  const result = await verifyRelease(bytes, anchors, { environment, expect,
    files: artifact.files, highest, unsigned: { project: artifact.subject.project, version: artifact.subject.version } });
  if (result.verdict !== 'VERIFIED') refuse(result.code ?? 'SIGNATURE_MISSING');
  return result;
}

export async function receipt(options) {
  const environment = options.environment ?? 'production';
  const anchors = await loadAnchors(readBounded(options.anchors, 4 * 1024 * 1024), environment);
  const signaturePath = resolve(safePath(options.artifact), SIGNATURE_FILE);
  let bytes = null;
  try { lstatSync(signaturePath); bytes = readBounded(signaturePath, 65536); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Authenticate before interpreting artifact bytes. Base never accepts a
  // legacy unsigned floor; the shared verifier refuses null without one.
  await verifyRelease(bytes, anchors, { environment });
  const artifact = await readArtifact(options.artifact);
  const highest = options.after ? { version: options.after.split(':')[0], statementSha256: options.after.split(':')[1] } : undefined;
  await verifyArtifact(artifact, anchors, environment, bytes, highest);
}
