// Actual Git objects and DSSE signatures; only GitHub's HTTP boundary is fake.
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { anchorSet, envelope, publicEntry, timestamp, validity } from '../../../../modules/release/signing-key.mjs';
import { PAYLOAD_TYPE, loadAnchors } from '../../../../modules/release/signature.mjs';
import { readArtifact, statementFor } from '../../../../modules/release/statement.mjs';
import { verifyArtifact } from '../../../../modules/release/verify.mjs';

export const repository = 'octocat/hello-world';
export const repositoryURL = `https://github.com/${repository}`;

export async function releaseNetwork(directory, env, command) {
 const { privateKey } = generateKeyPairSync('ed25519');
 const now = new Date();
 const entry = await publicEntry(privateKey, { scope: 'test', publisher: 'octocat',
  githubOwner: { login: 'octocat', id: 583231 }, ...validity(now), issuedAt: timestamp(now) });
 const anchors = join(directory, 'anchors.json'), anchorBytes = anchorSet(entry, 'test');
 await writeFile(anchors, JSON.stringify(anchorBytes), { mode: 0o600 });
 const loaded = await loadAnchors(anchorBytes, 'test');
 const responses = join(directory, 'github.json'), calls = join(directory, 'github-calls.jsonl');
 const bin = join(directory, 'bin'); await mkdir(bin);
 await writeFile(calls, '');
 await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}\n');
 await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), endpoint = args.find(arg => arg.startsWith('repos/'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
if (Object.hasOwn(state.files, endpoint)) process.stdout.write(fs.readFileSync(state.files[endpoint]));
else if (Object.hasOwn(state.json, endpoint)) {
 const result = state.json[endpoint];
 process.stdout.write(JSON.stringify(args.includes('--slurp') ? [result] : result));
} else { process.stderr.write('Unconfigured fixture GitHub endpoint: ' + endpoint); process.exitCode = 1; }
`);
 await chmod(join(bin, 'gh'), 0o755);
 const state = { json: {}, files: {} }, releases = [];
 const flush = () => writeFile(responses, JSON.stringify(state));
 await flush();
 async function publish(source, version, { unsigned = false } = {}) {
  const tag = `v${version}`, commit = await command('git', ['rev-parse', 'HEAD'], source);
  await command('git', ['tag', '-a', tag, '-m', `Fixture release ${version}`], source);
  const tree = await command('git', ['rev-parse', 'HEAD^{tree}'], source);
  const tagObject = await command('git', ['rev-parse', `refs/tags/${tag}`], source);
  const artifact = join(directory, 'releases', version), manifestPath = `site/upgrade-fixture/${version}/release.json`;
  await mkdir(dirname(join(artifact, manifestPath)), { recursive: true });
  await command('git', ['archive', '--format=tar', '-o', join(artifact, 'public-source.tar'), commit], source);
  const { sha256 } = await import('../../../../modules/release/signature.mjs');
  const manifest = { project: repository, release: version,
   listing: { id: 'upgrade-fixture', version, repository: repositoryURL },
   provenance: { repository: repositoryURL, revision: commit, tree, tag }, artifacts: [] };
  await writeFile(join(artifact, manifestPath), JSON.stringify(manifest));
  await writeFile(join(artifact, 'publish-check.json'), JSON.stringify({ status: 'PASS' }));
  const receipt = { status: 'RELEASED', tag: { name: tag, created: true },
   publicExport: { path: 'public-source.tar', commit, tree, tagObject, tag, sha256: await sha256(await readFile(join(artifact, 'public-source.tar'))) },
   siteRelease: { path: manifestPath, sha256: await sha256(await readFile(join(artifact, manifestPath))) },
   gates: { publishCheck: { reportSha256: await sha256(await readFile(join(artifact, 'publish-check.json'))) } } };
  await writeFile(join(artifact, 'release-receipt.json'), JSON.stringify(receipt));
  const read = await readArtifact(artifact), statement = statementFor(read, entry.keyId, timestamp(new Date()));
  const signature = join(artifact, 'rer-release.dsse.json');
  const bytes = Buffer.from(JSON.stringify(envelope(privateKey, entry.keyId, PAYLOAD_TYPE, statement)));
  await verifyArtifact(read, loaded, 'test', bytes);
  await writeFile(signature, bytes);
  const id = releases.length + 1;
  const release = { id, tag_name: tag, target_commitish: commit, draft: false, prerelease: false,
   assets: unsigned ? [] : [{ id, name: 'rer-release.dsse.json', size: bytes.length }] };
  state.json[`repos/${repository}/releases/tags/${tag}`] = release;
  state.json[`repos/${repository}/releases/latest`] = release;
  state.files[`repos/${repository}/releases/assets/${id}`] = signature;
  releases.unshift(release);
  state.json[`repos/${repository}/releases?per_page=100`] = releases;
  await flush();
  return { version, tag, commit, tree, tagObject, artifact, signature, statement, release };
 }
 return { anchors, bin, calls, publish, responses, state, flush, env };
}
