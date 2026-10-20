import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fixture } from './test-fixture.mjs';
import { release } from './produce.mjs';

const root = resolve(import.meta.dirname, '../..');
const cli = (args, input) => spawnSync(process.execPath, [resolve(root, 'bin/rer.mjs'), 'release', ...args],
  { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

test('release CLI signs produced bytes, verifies offline, and refuses changed signed marks and documents', async t => {
  const f = fixture(t);
  mkdirSync(resolve(f.repo, 'public/brand'), { recursive: true });
  writeFileSync(resolve(f.repo, 'public/brand/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>');
  f.commit();
  const produced = await release({ ...f.options, project: 'octocat/hello-world', repository: 'https://github.com/octocat/hello-world' });
  assert.equal(produced.status, 'RELEASED');
  const entryPath = resolve(f.temporary, 'entry.json'), anchorsPath = resolve(f.temporary, 'anchors.json');
  const generated = cli(['keygen', '--scope', 'test', '--publisher', 'octocat', '--github-owner', 'octocat', '--github-owner-id', '583231', '--anchor-out', entryPath]);
  // Never attach the private stdout to an assertion or diagnostic.
  const privateParts = [generated.stdout.trim(), ...generated.stdout.split(/\r?\n/).filter(line => line && !line.startsWith('-----'))].filter(Boolean);
  const publicOutput = (...streams) => assert.equal(streams.some(stream =>
    stream.includes('PRIVATE KEY') || privateParts.some(part => stream.includes(part))), false, 'CLI diagnostics must not expose private key material');
  const resultIs = (result, expected) => {
    try { return isDeepStrictEqual(JSON.parse(result.stdout), expected); } catch { return false; }
  };
  publicOutput(generated.stderr);
  assert.equal(generated.status, 0, 'Test key generation succeeds');
  assert.equal(generated.stdout.startsWith(['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')), true, 'Test key generation returns a PKCS8 PEM');
  const entry = JSON.parse(readFileSync(entryPath));
  writeFileSync(anchorsPath, JSON.stringify({ schemaVersion: 1, environment: 'test', serial: 1, legacyUnsigned: {}, keys: [entry] }));
  const signed = cli(['sign', '--artifact', f.options.output, '--key-stdin', '--scope', 'test'], generated.stdout);
  publicOutput(signed.stdout, signed.stderr);
  assert.equal(signed.status, 0, 'Release signing succeeds');
  assert.equal(/^gh release upload /.test(signed.stdout), true, 'Signing prints the upload command');
  const verify = () => cli(['receipt', '--artifact', f.options.output, '--anchors', anchorsPath, '--environment', 'test']);
  const accepted = verify();
  publicOutput(accepted.stdout, accepted.stderr);
  assert.equal(accepted.status, 0, 'Receipt verification succeeds');
  assert.equal(resultIs(accepted, { verdict: 'VERIFIED' }), true, 'The signed artifact is verified');
  const manifestPath = resolve(f.options.output, produced.siteRelease.path);
  const mark = resolve(dirname(manifestPath), JSON.parse(readFileSync(manifestPath)).listing.brand.mark);
  const markBytes = readFileSync(mark); writeFileSync(mark, '<svg/>');
  const changedMark = verify(); publicOutput(changedMark.stdout, changedMark.stderr);
  assert.equal(changedMark.status, 1, 'A changed mark is refused');
  assert.equal(resultIs(changedMark, { verdict: 'REFUSED', code: 'DIGEST_MISMATCH' }), true);
  writeFileSync(mark, markBytes);
  const document = resolve(dirname(manifestPath), JSON.parse(readFileSync(manifestPath)).artifacts[0].path);
  const bytes = readFileSync(document); bytes[0] ^= 1; writeFileSync(document, bytes);
  const refused = verify();
  publicOutput(refused.stdout, refused.stderr);
  assert.equal(refused.status, 1, 'A changed document is refused');
  assert.equal(resultIs(refused, { verdict: 'REFUSED', code: 'DIGEST_MISMATCH' }), true, 'The changed document reports a digest mismatch');
});
