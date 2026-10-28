import { caseRow, caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicFixture, git } from './public-child-fixture.mjs';

const arguments_ = ['--disable', '--config', '-'];
function request(f, name, url = f.options.repository + '/info/refs?service=git-upload-pack', body) {
  const output = resolve(f.temporary, name + '.body'), headers = resolve(f.temporary, name + '.headers');
  const options = { url, output, 'dump-header': headers, 'max-time': '15', 'write-out': '%{http_code}\n%{content_type}\n%{url_effective}\n' };
  if (body !== undefined) {
    const source = resolve(f.temporary, name + '.request');
    writeFileSync(source, body);
    options['data-binary'] = '@' + source;
  }
  return { output, headers, config: Object.entries(options).map(([key, value]) => key + ' = ' + JSON.stringify(value) + '\n').join('') };
}
const curl = request => spawnSync('curl', arguments_, { input: request.config, encoding: 'utf8', timeout: 15000 });
const success = result => assert.equal(result.status, 0, result.stderr);
const packet = body => Buffer.from((Buffer.byteLength(body) + 4).toString(16).padStart(4, '0') + body);

test('smart HTTP fixture returns genuine native advertisements and an importable exact object graph', t => {
  const f = publicFixture(t), config = JSON.parse(readFileSync(resolve(f.temporary, 'transport/config.json')));
  const advert = request(f, 'advert');
  success(curl(advert));
  const native = execFileSync(config.actualGit, ['upload-pack', '--stateless-rpc', '--advertise-refs', f.bare]);
  assert.deepEqual(readFileSync(advert.output), Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), native]));
  const exchange = request(f, 'exchange', f.options.repository + '/git-upload-pack',
    Buffer.concat([packet(`want ${f.parent}\n`), Buffer.from('0000'), packet('done\n')]));
  success(curl(exchange));
  const bytes = readFileSync(exchange.output);
  assert.equal(bytes.subarray(0, 12).toString(), '0008NAK\nPACK');
  const imported = resolve(f.temporary, 'imported.git');
  execFileSync(config.actualGit, ['init', '--bare', '-q', imported]);
  execFileSync(config.actualGit, ['-C', imported, 'index-pack', '--stdin'], { input: bytes.subarray(8) });
  assert.equal(git(imported, 'show', `${f.parent}:README.md`), String(f.files['README.md']).trim());
  assert.equal(git(imported, 'rev-parse', `${f.parent}^{tree}`), git(f.bare, 'rev-parse', 'main^{tree}'));
  assert.deepEqual(f.state(), { heads: 0, fetches: 1 });
});

test('HTTP fixture rejects unknown destination, path, method and unsupported curl invocation before effects', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  const cases = [
    ['https://other.invalid/repo/info/refs?service=git-upload-pack'],
    [f.options.repository + '.extra/info/refs?service=git-upload-pack'],
    [f.options.repository + '/info/refs?service=git-receive-pack'],
    [f.options.repository + '/info/refs?service=git-upload-pack', 'unexpected POST'],
    [f.options.repository + '/git-upload-pack'],
    [f.options.repository + '/git-receive-pack', 'unexpected write'],
  ];
  let rowAt52 = 0;
  for (const [index, [url, body]] of cases.entries()) {
    await caseRow(t, 'table at line 52 row ' + rowAt52++, async () => {

    const query = request(f, `rejected-${index}`, url, body), result = curl(query);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(query.output), false);
    assert.equal(existsSync(query.headers), false);
      });
  }
  await caseRow(t, 'following assertion at line 59', async () => { assert.notEqual(spawnSync('curl', ['--url', f.options.repository], { encoding: 'utf8', timeout: 15000 }).status, 0); });
  await caseRow(t, 'following assertion at line 60', async () => { assert.equal(existsSync(resolve(f.temporary, 'transport.json')), false); });
  }]]);
});

test('HTTP fixture rejects excessive config and request bytes and refuses a native unknown-object request', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  const excessiveConfig = request(f, 'large-config');
  excessiveConfig.config += 'header = ' + JSON.stringify('x'.repeat(65536)) + '\n';
  const excessiveBody = request(f, 'large-body', f.options.repository + '/git-upload-pack', Buffer.alloc(1024 * 1024 + 1));
  let rowAt68 = 0;
  for (const query of [excessiveConfig, excessiveBody]) {
    await caseRow(t, 'table at line 68 row ' + rowAt68++, async () => {

    assert.notEqual(curl(query).status, 0);
    assert.equal(existsSync(query.output), false);
      });
  }
  await caseRow(t, 'following assertion at line 72', async () => { assert.equal(existsSync(resolve(f.temporary, 'transport.json')), false); });
  const unknown = request(f, 'unknown-object', f.options.repository + '/git-upload-pack',
    Buffer.concat([packet('want ' + 'f'.repeat(40) + '\n'), Buffer.from('0000'), packet('done\n')]));
  await caseRow(t, 'following assertion at line 75', async () => { assert.notEqual(curl(unknown).status, 0); });
  await caseRow(t, 'following assertion at line 76', async () => { assert.equal(existsSync(unknown.output), false); });
  await caseRow(t, 'following assertion at line 77', async () => { assert.deepEqual(readdirSync(f.temporary).filter(name => name.startsWith('transport.json.')), []); });
  }]]);
});

test('HTTP and Git transport requests share atomic counters and unchanged head-move hooks', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'README.md'), 'Changed public head.\n');
  const changed = f.commit();
  git(f.repo, 'push', f.bare, 'HEAD:refs/heads/other');
  f.configure({ moveTo: changed });
  const run = (command, args, input) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
  const queries = [request(f, 'concurrent-a'), request(f, 'concurrent-b')];
  const results = await Promise.allSettled([
    ...queries.map(query => run('curl', arguments_, query.config)),
    ...[0, 1].map(() => run('git', ['-C', f.repo, 'ls-remote', '--refs', f.options.repository, 'refs/heads/main'])),
  ]);
  let rowAt95 = 0;
  for (const result of results) {
    await caseRow(t, 'table at line 95 row ' + rowAt95++, async () => {
assert.equal(result.status, 'fulfilled', result.reason?.message);
    });
  }
  await caseRow(t, 'following assertion at line 96', async () => { assert.deepEqual(results.slice(2).map(result => result.value).sort(), [`${f.parent}\trefs/heads/main\n`, `${changed}\trefs/heads/main\n`].sort()); });
  await caseRow(t, 'following assertion at line 97', async () => { assert.deepEqual(f.state(), { heads: 2, fetches: 2 }); });
  await caseRow(t, 'following assertion at line 98', async () => { assert.deepEqual(readdirSync(f.temporary).filter(name => name.startsWith('transport.json.')), []); });
  }]]);
});
