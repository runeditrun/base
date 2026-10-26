import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProjectDescriptor} from '../generators/project.mjs';

const cases=JSON.parse(readFileSync(new URL('./source-repository-cases.json',import.meta.url),'utf8').replaceAll('{github-host}', 'github.com').replaceAll('{GITHUB-HOST}', 'GITHUB.COM').replaceAll('{GitHub-Host}', 'GiThUb.CoM'));
const descriptor={schema:1,projectId:'publisher/app',name:'App',sourceRepository:'octocat/Hello-World',license:'MIT',deployment:{target:'cloudflare-workers'},operations:{build:'make build',verify:'make test',recovery:'Restore retained data'}};
// Keep the complete refusal corpus: these rows guard repository identity and
// URL security. Each registration follows one descriptor behavior through its
// public producer API, with the input retained in assertion failure messages.
test('descriptor producer canonicalizes legacy repository identities', () => {
  for (const value of cases.acceptedBare) {
    assert.equal(generateProjectDescriptor({...descriptor, sourceRepository: value}).sourceRepository,
      `https://github.com/${value}`, value);
  }
});
test('descriptor producer refuses unrepresentable bare repository identities', () => {
  for (const value of cases.unrepresentableBare) {
    assert.throws(() => generateProjectDescriptor({...descriptor, sourceRepository: value}),
      /literal \.git repository name/, value);
  }
});
test('descriptor producer canonicalizes repository URLs idempotently', () => {
  for (const {value, identity, canonicalizable} of cases.acceptedUrls) {
    if (canonicalizable === false) continue;
    const result = generateProjectDescriptor({...descriptor, sourceRepository: value});
    assert.equal(result.sourceRepository, `https://github.com/${identity}`, value);
    assert.deepEqual(generateProjectDescriptor(result), result, value);
  }
});
test('descriptor producer refuses unrepresentable URL repository identities', () => {
  for (const {value, canonicalizable} of cases.acceptedUrls) {
    if (canonicalizable !== false) continue;
    assert.throws(() => generateProjectDescriptor({...descriptor, sourceRepository: value}),
      /literal \.git repository name/, value);
  }
});
test('descriptor producer rejects unsafe repository identities', () => {
  for (const value of [...cases.rejectedUrls, ...cases.rejectedBare]) {
    assert.throws(() => generateProjectDescriptor({...descriptor, sourceRepository: value}),
      /https:\/\/github\.com\/<owner>\/<repo>/, JSON.stringify(value));
  }
});
