import { lstatSync, readdirSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { sha256, validateStatement, validRelativePath as pathOK } from './signature.mjs';
import { FILE_LIMIT, SIGNATURE_FILE, safePath, readBounded, parseJSON, refuse } from './signing-io.mjs';

const required = ['public-source.tar', 'release-receipt.json', 'publish-check.json'];
export function repositoryURL(value) {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+(?:\.git)?$/i.test(value)) refuse('SUBJECT_MISMATCH');
  return value.toLowerCase().replace(/\.git$/, '');
}

export async function readArtifact(directory) {
  const root = safePath(directory);
  if (!lstatSync(root).isDirectory()) refuse('PATH_UNSAFE');
  const receiptBytes = readBounded(resolve(root, 'release-receipt.json'));
  const receipt = parseJSON(receiptBytes);
  const manifestPath = receipt?.siteRelease?.path;
  if (!pathOK(manifestPath) || !/^site\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/release\.json$/.test(manifestPath)) refuse('PATH_UNSAFE');
  const base = posix.dirname(manifestPath);
  const selected = new Map();
  const isAsset = path => path.startsWith(`${base}/assets/`);
  const walk = (relative = '') => {
    for (const name of readdirSync(resolve(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const ancillary = path === 'public-git' || path.startsWith('public-git/');
      // Unsigned source names may be Unicode; only the root Git metadata may
      // use .git. Signed paths retain the statement's printable ASCII rules.
      if (ancillary) {
        if (path.includes('\0') || path.includes('\\') || path.split('/').some((part, index) =>
          !part || part === '.' || part === '..' || (part === '.git' && index !== 1))) refuse('PATH_UNSAFE');
      } else if (!pathOK(path)) refuse('PATH_UNSAFE');
      const stat = lstatSync(resolve(root, path));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) refuse('PATH_UNSAFE');
      if (stat.isFile() && stat.size > FILE_LIMIT) refuse('INPUT_TOO_LARGE');
      if (stat.isDirectory()) {
        if (!ancillary && path !== 'site' && path !== posix.dirname(base) && path !== base && path !== `${base}/documents` && !path.startsWith(`${base}/documents/`) && path !== `${base}/assets` && !isAsset(path)) refuse('FILE_UNDECLARED');
        walk(path);
      } else if (required.includes(path) || path === manifestPath || path.startsWith(`${base}/documents/`) || isAsset(path)) {
        selected.set(path, stat.size);
        if (selected.size > 256) refuse('INPUT_TOO_LARGE');
      } else if (!ancillary && !['PUBLISH.md', 'site/registry.json', SIGNATURE_FILE].includes(path)) refuse('FILE_UNDECLARED');
    }
  };
  walk();
  for (const path of [...required, manifestPath]) if (!selected.has(path)) refuse('FILE_MISSING');
  const files = new Map();
  for (const path of [...selected.keys()].sort()) files.set(path, path === 'release-receipt.json' ? receiptBytes : readBounded(resolve(root, path)));
  const manifest = parseJSON(files.get(manifestPath));
  const publicExport = receipt.publicExport;
  if (!publicExport || publicExport.path !== 'public-source.tar' || !manifest?.provenance || !manifest?.listing) refuse('SUBJECT_MISMATCH');
  const subject = { publisher: manifest.project?.split('/')[0], project: manifest.project, version: manifest.release,
    repository: repositoryURL(manifest.provenance.repository), tag: publicExport.tag,
    publicCommit: publicExport.commit, publicTree: publicExport.tree, tagObject: publicExport.tagObject };
  if (manifestPath !== `site/${manifest.listing.id}/${subject.version}/release.json` || manifest.listing.version !== subject.version || repositoryURL(manifest.listing.repository) !== subject.repository ||
      manifest.provenance.revision !== subject.publicCommit || manifest.provenance.tree !== subject.publicTree || manifest.provenance.tag !== subject.tag || receipt.tag?.name !== subject.tag) refuse('SUBJECT_MISMATCH');
  const entries = [];
  for (const [path, bytes] of files) entries.push({ path, sha256: await sha256(bytes), size: bytes.length });
  const digests = new Map(entries.map(entry => [entry.path, entry.sha256]));
  const match = (path, digest) => { if (typeof digest !== 'string' || digests.get(path) !== digest) refuse('DIGEST_MISMATCH'); };
  match('public-source.tar', publicExport.sha256);
  match('publish-check.json', receipt.gates?.publishCheck?.reportSha256);
  match(manifestPath, receipt.siteRelease.sha256);
  if (!Array.isArray(manifest.artifacts)) refuse('STATEMENT_INVALID');
  const declared = new Set();
  for (const artifact of manifest.artifacts) {
    if (!pathOK(artifact?.path) || !(artifact.path.startsWith('documents/') || artifact.path.startsWith(`assets/seeds/${manifest.listing.id}/`))) refuse('PATH_UNSAFE');
    const path = `${base}/${artifact.path}`;
    if (declared.has(path)) refuse('STATEMENT_INVALID');
    declared.add(path);
    if (!files.has(path)) refuse('FILE_MISSING');
    match(path, artifact.sha256);
  }
  for (const path of files.keys()) if ((path.startsWith(`${base}/documents/`) || isAsset(path)) && !declared.has(path)) refuse('FILE_UNDECLARED');
  for (const path of [manifest.listing.brand?.mark, manifest.listing.brand?.markLight, ...(manifest.listing.shots ?? []).map(shot => typeof shot === 'string' ? shot : shot.path)].filter(Boolean)) {
    if (!pathOK(path) || !declared.has(`${base}/${path}`)) refuse('FILE_MISSING');
  }
  return { root, receipt, subject, files, entries };
}

export function statementFor(artifact, keyId, issuedAt) {
  const statement = { schemaVersion: 1, ...artifact.subject, files: artifact.entries, issuedAt, keyId };
  validateStatement(statement);
  return statement;
}
