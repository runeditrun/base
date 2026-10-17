import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseContract } from '../../foundation/runtime/seed-contract.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';

// The listing's clauses are the contract's published ones, read by the parser
// `rer check` and the run site use: a malformed contract throws its ContractError.
function clauses(text) {
  const result = parseContract(text).clauses.filter(clause => clause.kind === 'published' && clause.text)
    .sort((a, b) => a.line - b.line).map(({ id, title, text }) => ({ id, title, text }));
  if (!result.length) throw Error('CONTRACT.md must contain published clauses');
  return result;
}

export function catalogue(source, project, repository, gates, dryRun) {
  const s = source.seed;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id)) throw Error('Invalid seed listing ID');
  for (const key of ['name', 'category', 'description', 'maturity'])
    if (typeof s[key] !== 'string' || !s[key]) throw Error('Incomplete seed listing metadata');
  const contract = clauses(source.bytes('CONTRACT.md').toString());
  const licence = source.bytes('LICENSE').toString();
  if (!licence.includes('Permission is hereby granted, free of charge')) throw Error('Declare a supported listing license');
  const docs = ['seed.json', 'CONTRACT.md', 'AGENTS.md', 'LICENSE', 'RELEASE.json',
    ...['README.md', 'BASELINE.md', 'OPERATIONS.md', 'ACCEPTANCE.md'].filter(path => source.entries.has(path))];
  const artifacts = docs.map(path => ({ path: `documents/${path}`, target: `agents/seeds/${s.id}/${path}`, sha256: sha256(source.bytes(path)) }));
  const listing = { id: s.id, name: s.name, licence: 'MIT', repository, category: s.category,
    categoryLabel: s.categoryLabel ?? s.category, version: s.version, oneLiner: s.description,
    summary: s.description, maturity: s.maturity, replaces: s.replaces ?? [], clauses: contract,
    clauseCount: contract.length, nonGoals: s.nonGoals ?? [], externals: (s.externals ?? []).map(e => ({
      name: e.name ?? e.id, reason: e.reason ?? e.why, required: e.required, data: e.data ?? [], adapters: e.adapters ?? [],
    })), extensionPoints: Array.isArray(s.extensionPoints) ? s.extensionPoints : Object.values(s.extensionPoints ?? {}).flat(),
    shots: [], landing: null, hasReadme: docs.includes('README.md'), hasBaseline: docs.includes('BASELINE.md'), manifestFile: 'seed.json' };
  for (const key of ['scope', 'spine', 'composition', 'operatingCost', 'limits', 'accessibility']) if (s[key] !== undefined) listing[key] = s[key];
  return { schemaVersion: 1, project, release: s.version, provenance: {
    kind: dryRun ? 'release-preview' : 'publisher-release', repository, revision: source.commit, tree: source.tree,
    publication: dryRun ? (gates.verify.status === 'PASS' && gates.publishCheck.status === 'PASS' ? 'dry-run' : 'blocked') : 'local-release',
    tag: source.tag, gates, note: dryRun
      ? (source.publicTagStaged ? 'Local review preview; public export tag staged. No private source tag created or push performed.'
        : 'Local review preview; no tag created or pushed and no visibility change.')
      : 'Local tag and export; no push, deployment or visibility change.',
  }, listing, artifacts };
}

export function writeCatalogue(source, output, manifest) {
  const directory = resolve(output, 'site', source.seed.id, source.seed.version);
  for (const artifact of manifest.artifacts) {
    const path = resolve(directory, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.bytes(artifact.path.slice('documents/'.length)), { flag: 'wx' });
  }
  const bytes = json(manifest);
  const releasePath = `${source.seed.id}/${source.seed.version}/release.json`;
  writeFileSync(resolve(directory, 'release.json'), bytes, { flag: 'wx' });
  writeFileSync(resolve(output, 'site/registry.json'), json({ schemaVersion: 1, snapshot: source.timestamp,
    releases: [{ path: releasePath, sha256: sha256(bytes) }] }), { flag: 'wx' });
  return { path: `site/${releasePath}`, sha256: sha256(bytes) };
}
