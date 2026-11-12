import { caseRow, caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicFixture, git } from './public-child-fixture.mjs';

function startGit(f, ...args) {
  // Own the wrapper and its native Git descendants so a failed live probe cannot
  // leave a batch reader behind when its wrapper is terminated.
  const child = spawn('git', ['-C', f.repo, ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const kill = () => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const timer = setTimeout(kill, 15000);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
  const stop = async () => {
    child.stdin.end();
    const grace = setTimeout(kill, 1000);
    try { await done; } finally { clearTimeout(grace); }
  };
  return { child, done, stop };
}

async function runGit(f, ...args) {
  const { child, done } = startGit(f, ...args);
  child.stdin.end();
  return done;
}

const statePath = f => resolve(f.temporary, 'transport.json');
const remoteArgs = f => ['ls-remote', '--refs', f.options.repository, 'refs/heads/main'];
const success = result => { assert.equal(result.status, 0, result.stderr); return result.stdout; };
const noStateDebris = f => assert.deepEqual(readdirSync(f.temporary).filter(name => name.startsWith('transport.json.')), []);

test('live local cat-file overlaps rev-parse without creating transport state', async t => {
  const f = publicFixture(t);
  const { child, done, stop } = startGit(f, 'cat-file', '--batch');
  t.after(stop);
  const expected = f.files['README.md'];
  const response = new Promise((resolve, reject) => {
    let bytes = '';
    child.stdout.on('data', chunk => {
      bytes += chunk;
      if (bytes.endsWith('\n' + expected + '\n')) resolve(bytes);
    });
    done.then(result => reject(new Error(`cat-file exited before its object response: ${result.stderr}`)), reject);
  });
  child.stdin.write(`${f.parent}:README.md\n`);
  let responseTimer;
  const timeout = new Promise((_, reject) => {
    responseTimer = setTimeout(() => reject(new Error('Timed out waiting for the live cat-file object response')), 5000);
  });
  let bytes;
  try { bytes = await Promise.race([response, timeout]); }
  finally { clearTimeout(responseTimer); }
  assert.match(bytes, new RegExp(`^[a-f0-9]{40} blob ${Buffer.byteLength(expected)}\\n`));
  assert.equal(bytes.split('\n').slice(1).join('\n'), expected + '\n');
  assert.equal(child.exitCode, null);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(success(await runGit(f, 'rev-parse', 'HEAD')).trim(), f.parent);
  assert.equal(child.exitCode, null, 'cat-file stays alive while rev-parse completes');
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(existsSync(statePath(f)), false);
  noStateDebris(f);
  child.stdin.end();
  success(await done);
});

test('local commands preserve state bytes and bypass another transport lock', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  success(await runGit(f, ...remoteArgs(f)));
  const path = statePath(f), lock = path + '.lock';
  const original = Buffer.from('  ' + readFileSync(path, 'utf8') + '\n');
  writeFileSync(path, original);
  mkdirSync(lock);
  writeFileSync(resolve(lock, 'owner'), 'another invocation');
  let rowAt88 = 0;
  for (const args of [['rev-parse', 'HEAD'], ['cat-file', '-t', f.parent], ['write-tree']]) {
    await caseRow(t, 'table at line 88 row ' + rowAt88++, async () => {

    const result = spawnSync('git', ['-C', f.repo, ...args], { encoding: 'utf8', timeout: 3000 });
    success(result);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(readFileSync(resolve(lock, 'owner'), 'utf8'), 'another invocation');
      });
  }
  // A crashed owner's lock has a bounded, explicit failure and remains its own.
  const result = spawnSync('git', ['-C', f.repo, ...remoteArgs(f)], { encoding: 'utf8', timeout: 15000 });
  await caseRow(t, 'following assertion at line 96', async () => { assert.equal(result.error, undefined); });
  await caseRow(t, 'following assertion at line 97', async () => { assert.notEqual(result.status, 0); });
  await caseRow(t, 'following assertion at line 98', async () => { assert.match(result.stderr, /Timed out waiting for fixture transport state lock/); });
  await caseRow(t, 'following assertion at line 99', async () => { assert.deepEqual(readFileSync(path), original); });
  await caseRow(t, 'following assertion at line 100', async () => { assert.equal(readFileSync(resolve(lock, 'owner'), 'utf8'), 'another invocation'); });
  rmSync(lock, { recursive: true });
  noStateDebris(f);
  }]]);
});

test('keyword remote names and global option values stay local with mapped URLs', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t), path = statePath(f), lock = path + '.lock';
  const prefixes = [
    [], ['-C', f.repo, '-c', 'fixture.command=fetch', '-c', 'fixture.query=ls-remote'],
    ['--namespace', 'fetch'], ['--namespace=ls-remote'],
    ['--git-dir', resolve(f.repo, '.git'), '--work-tree', f.repo],
    ['--git-dir=' + resolve(f.repo, '.git'), '--work-tree=' + f.repo],
    ['--config-env', 'fixture.command=PATH'], ['--config-env=fixture.command=PATH'],
    ['--no-pager', '--no-replace-objects', '--no-optional-locks'],
    ['--exec-path=' + git(f.repo, '--exec-path')],
  ];
  let original;
  let rowAt117 = 0;
  for (const heldLock of [false, true]) {
    await caseRow(t, 'table at line 117 row ' + rowAt117++, async () => {

    if (heldLock) {
      success(await runGit(f, ...remoteArgs(f)));
      original = readFileSync(path);
      mkdirSync(lock);
      writeFileSync(resolve(lock, 'owner'), 'another invocation');
    }
    assert.equal(success(await runGit(f, '--exec-path', 'fetch', f.options.repository)).trim(), git(f.repo, '--exec-path'));
    for (const prefix of prefixes) {
      for (const name of ['fetch', 'ls-remote']) {
        success(await runGit(f, ...prefix, 'remote', 'add', name, f.options.repository));
        assert.equal(success(await runGit(f, 'config', '--get', `remote.${name}.url`)).trim(), f.bare);
        success(await runGit(f, ...prefix, 'remote', 'set-url', name, f.options.repository));
        success(await runGit(f, 'remote', 'remove', name));
        if (heldLock) {
          assert.deepEqual(readFileSync(path), original);
          assert.equal(readFileSync(resolve(lock, 'owner'), 'utf8'), 'another invocation');
          assert.deepEqual(readdirSync(f.temporary).filter(name => name.startsWith('transport.json.')), ['transport.json.lock']);
        } else {
          assert.equal(existsSync(path), false);
          noStateDebris(f);
        }
      }
    }
    if (heldLock) rmSync(lock, { recursive: true });
      });
  }
  await caseRow(t, 'following assertion at line 143', async () => { assert.deepEqual(f.state(), { heads: 1, fetches: 0 }); });
  noStateDebris(f);
  }]]);
});

test('ls-remote URL queries bypass transport state and locks using native option semantics', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t), path = statePath(f), lock = path + '.lock';
  const queries = [
    ['--get-url', f.options.repository], ['--get', f.options.repository],
    ['--no-get-url', '--get-url', f.options.repository],
    ['--get-url', '--upload-pack', '--no-get-url', f.options.repository],
    ['--get-url', '--sort', '--no-get-url', f.options.repository],
    ['--get-url', '-o', '--no-get-url', f.options.repository],
    ['--get-url', '--', f.options.repository, '--no-get-url'],
  ];
  let original;
  let rowAt158 = 0;
  for (const heldLock of [false, true]) {
    await caseRow(t, 'table at line 158 row ' + rowAt158++, async () => {

    if (heldLock) {
      success(await runGit(f, ...remoteArgs(f)));
      original = readFileSync(path);
      mkdirSync(lock);
      writeFileSync(resolve(lock, 'owner'), 'another invocation');
    }
    for (const args of queries) {
      assert.equal(success(await runGit(f, '-c', 'fixture.command=fetch', 'ls-remote', ...args)).trim(), f.bare);
      if (heldLock) {
        assert.deepEqual(readFileSync(path), original);
        assert.equal(readFileSync(resolve(lock, 'owner'), 'utf8'), 'another invocation');
        assert.deepEqual(readdirSync(f.temporary).filter(name => name.startsWith('transport.json.')), ['transport.json.lock']);
      } else {
        assert.equal(existsSync(path), false);
        noStateDebris(f);
      }
    }
    if (heldLock) rmSync(lock, { recursive: true });
      });
  }
  await caseRow(t, 'following assertion at line 178', async () => { assert.deepEqual(f.state(), { heads: 1, fetches: 0 }); });
  noStateDebris(f);
  }]]);
});

test('global prefixes retain mapped transport counts and URL-query-looking patterns stay remote', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  const prefixes = [
    ['-C', f.repo, '-c', 'fixture.command=fetch', '--no-replace-objects'],
    ['--git-dir=' + resolve(f.repo, '.git'), '--work-tree', f.repo],
    ['--config-env', 'fixture.command=PATH', '--namespace', 'ls-remote', '--namespace='],
  ];
  let rowAt189 = 0;
  for (const prefix of prefixes) {
    await caseRow(t, 'table at line 189 row ' + rowAt189++, async () => {

    assert.equal(success(await runGit(f, ...prefix, ...remoteArgs(f))), `${f.parent}\trefs/heads/main\n`);
    success(await runGit(f, ...prefix, 'fetch', '--quiet', '--no-write-fetch-head', f.options.repository, 'refs/heads/main'));
      });
  }
  await caseRow(t, 'following assertion at line 193', async () => { assert.deepEqual(f.state(), { heads: 3, fetches: 3 }); });
  await caseRow(t, 'following assertion at line 194', async () => { assert.equal(success(await runGit(f, 'ls-remote', '--get-url', '--no-get-url', f.options.repository, 'refs/heads/main')), `${f.parent}\trefs/heads/main\n`); });
  await caseRow(t, 'following assertion at line 195', async () => { assert.equal(success(await runGit(f, 'ls-remote', f.options.repository, '--get-url')), ''); });
  await caseRow(t, 'following assertion at line 196', async () => { assert.equal(success(await runGit(f, 'ls-remote', '--', f.options.repository, '--get-url')), ''); });
  await caseRow(t, 'following assertion at line 197', async () => { assert.deepEqual(f.state(), { heads: 6, fetches: 3 }); });
  // -h is the native heads selector here, and a pattern/refspec can itself be
  // called fetch or ls-remote without changing which counter owns the request.
  await caseRow(t, 'following assertion at line 200', async () => { assert.equal(success(await runGit(f, 'ls-remote', '-h', f.options.repository, 'refs/heads/main')), `${f.parent}\trefs/heads/main\n`); });
  await caseRow(t, 'following assertion at line 201', async () => { assert.equal(success(await runGit(f, 'ls-remote', f.options.repository, 'fetch')), ''); });
  git(f.bare, 'update-ref', 'refs/heads/ls-remote', f.parent);
  success(await runGit(f, 'fetch', '--quiet', '--no-write-fetch-head', f.options.repository, 'ls-remote'));
  await caseRow(t, 'following assertion at line 204', async () => { assert.deepEqual(f.state(), { heads: 8, fetches: 4 }); });
  noStateDebris(f);
  }]]);
});

test('concurrent mapped heads and fetches preserve counts and publish atomic JSON', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = publicFixture(t);
  success(await runGit(f, ...remoteArgs(f)));
  const path = statePath(f), original = readFileSync(path);
  const oldFile = openSync(path, 'r');
  t.after(() => closeSync(oldFile));
  const snapshots = [], readErrors = [];
  const sample = () => {
    try { snapshots.push(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) { readErrors.push(error.message); }
  };
  const reader = setInterval(sample, 1);
  try {
    // Four native processes at a time, with both counters competing for the lock.
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        runGit(f, ...remoteArgs(f)), runGit(f, ...remoteArgs(f)),
        runGit(f, 'fetch', '--quiet', '--no-write-fetch-head', f.options.repository, 'refs/heads/main'),
        runGit(f, 'fetch', '--quiet', '--no-write-fetch-head', f.options.repository, 'refs/heads/main'),
      ]);
      results.forEach(success);
      sample();
    }
  } finally { clearInterval(reader); }
  assert.deepEqual(readErrors, []);
  assert.ok(snapshots.length > 3, 'read JSON while the native operations run');
  let previous = { heads: 1, fetches: 0 };
  let rowAt235 = 0;
  for (const snapshot of snapshots) {
    await caseRow(t, 'table at line 235 row ' + rowAt235++, async () => {

    assert.ok(Number.isInteger(snapshot.heads) && Number.isInteger(snapshot.fetches));
    assert.ok(snapshot.heads >= previous.heads && snapshot.fetches >= previous.fetches);
    previous = snapshot;
      });
  }
  await caseRow(t, 'following assertion at line 240', async () => { assert.deepEqual(f.state(), { heads: 7, fetches: 6 }); });
  // An open descriptor must retain the old inode's bytes across every update.
  await caseRow(t, 'following assertion at line 242', async () => { assert.deepEqual(readFileSync(oldFile), original); });
  noStateDebris(f);
  }]]);
});

test('concurrent head hooks use their own snapshot and release owned locks', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'README.md'), 'Changed public head.\n');
  const changed = f.commit();
  git(f.repo, 'push', f.bare, 'HEAD:refs/heads/other');
  f.configure({ moveTo: changed, ambiguousAfter: true });
  const results = await Promise.all(Array.from({ length: 3 }, () => runGit(f, ...remoteArgs(f))));
  const first = `${f.parent}\trefs/heads/main\n`, next = `${changed}\trefs/heads/main\n`;
  assert.deepEqual(results.map(success).sort(), [first, next, next + next].sort());
  assert.deepEqual(f.state(), { heads: 3, fetches: 0 });
  noStateDebris(f);
});

test('unresolved remote and native failure preserve exits and release owned locks', async t => {
  const f = publicFixture(t);
  f.configure({ unresolvedAfter: true });
  success(await runGit(f, ...remoteArgs(f)));
  const unresolved = await runGit(f, ...remoteArgs(f));
  assert.equal(unresolved.status, 1);
  assert.equal(unresolved.stdout, ''); assert.equal(unresolved.stderr, '');
  noStateDebris(f);
  const failed = await runGit(f, 'fetch', '--quiet', f.options.repository, 'refs/heads/missing');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /couldn't find remote ref/);
  assert.deepEqual(f.state(), { heads: 2, fetches: 1 });
  noStateDebris(f);
  success(await runGit(f, ...remoteArgs(f)));
  assert.deepEqual(f.state(), { heads: 3, fetches: 1 });
});

test('local write-tree still corrupts the real index without transport state', t => {
  const f = publicFixture(t);
  const original = git(f.repo, 'rev-parse', 'HEAD^{tree}');
  f.configure({ corruptTree: true });
  const changed = git(f.repo, 'write-tree');
  assert.notEqual(changed, original);
  assert.equal(git(f.repo, 'show', ':README.md'), 'corrupted real blob');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD^{tree}'), original);
  assert.equal(existsSync(statePath(f)), false);
  noStateDebris(f);
});
