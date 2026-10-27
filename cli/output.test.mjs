import test from 'node:test';
import { printer } from '../global/launch/render.mjs';
import { ready } from './managed-server.mjs';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('CLI human readiness, phase timing and machine output stay distinct; large JSON reports drain at both entries', async t => {
 const stdout = [], stderr = [];
 let now = 0;
 const mocks = [t.mock.method(process.stdout, 'write', text => { stdout.push(text); return true; }), t.mock.method(process.stderr, 'write', text => { stderr.push(text); return true; }), t.mock.method(Date, 'now', () => now)];
 try {
  const details = { version: 1, verb: 'dev', event: 'ready', url: 'http://127.0.0.1:3000', signedInAs: 'synthetic-base-1@example.test', openUrl: 'http://127.0.0.1:3000/#synthetic-base-1', siteUrl: 'http://127.0.0.1:3001' };
  const out = printer({ json: false, stopHint: 'Ctrl-C' });
  out.phase({ phase: 'install', message: 'installing' }); now = 60400; out.heartbeat();
  out.phase({ phase: 'setup', message: 'setting up' }); now = 68600; out.phase({phase:'note',message:'working'}); now = 88600; out.heartbeat();
  assert.match(stderr.join(''), /still installing \(1m 0s\)/);
  assert.match(stderr.join(''), /still setting up \(28s\)/);
  out.ready(details, {});
  assert.equal(stdout.join('').split('\n')[0], `Your app is ready, open it: ${details.openUrl}`);
  assert.match(stdout.join(''), /Site: http:\/\/127\.0\.0\.1:3001/);
  const machine = stdout.join('').split('\n').filter(line => line.startsWith('RER_')).join('\n');
  assert.equal(machine, `RER_READY ${details.url}\nRER_SIGNED_IN ${details.signedInAs}\nRER_OPEN ${details.openUrl}\nRER_SITE ${details.siteUrl}`);
  stdout.length = 0;
  printer({json:true}).ready(details, {pid:123});
  assert.equal(stdout.join(''), JSON.stringify({version:1,verb:'dev',event:'server',pid:123})+'\n'+JSON.stringify(details)+'\n');
  stdout.length = 0;
  const output = {human: text => stdout.push(text+'\n'),event:(event,fields)=>stdout.push(JSON.stringify({version:1,verb:'dev',event,...fields})+'\n')};
  ready(output, details.url, details, true, details.siteUrl);
  assert.equal(stdout.join(''), JSON.stringify(details)+'\n');
  stdout.length = 0; ready(output, details.url, details, false, details.siteUrl);
  assert.equal(stdout[0], `Your app is ready, open it: ${details.openUrl}\n`);
  assert.equal(stdout.join('').split('\n').filter(line=>line.startsWith('RER_')).join('\n'), machine);
 } finally { for (const mock of mocks) mock.mock.restore(); }

 const root = await mkdtemp(join(tmpdir(), 'rer-output-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const effects = 'Read the complete description: café 日本語. '.repeat(16384);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({
  version: 2, project: 'example/output', runtime: { requirements: [] },
  requiredEnvironment: Array.from({ length: 128 }, (_, i) => `OUTPUT_REQUIRED_${i}`),
  commands: { verify: { argv: ['node', '--version'], inputs: [], effects } },
 }));
 const consumer = join(root, 'consume.mjs');
 await writeFile(consumer, "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8'))) + '\\n');\n");
 // CI checks out as a different uid and trusts Base in its original HOME.
 // Keep the isolated HOME while granting only this source checkout that trust:
 // describe reads its Git version before it writes the document.
 const env = { PATH: process.env.PATH, HOME: root, RER_NO_UPDATE_CHECK: '1',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: base };
 for (const entry of ['bin/rer.mjs', 'global/rer.mjs']) for (const [args, status] of [
  [['describe', '--json'], 0],
  [['check', '--json', '--profile', 'first-party'], 1],
  [['doctor', '--json'], 3],
 ]) {
  const destination = join(root, 'description.json'), fd = openSync(destination, 'w');
  let file;
  try { file = spawnSync(process.execPath, [join(base, entry), ...args], { cwd: root, env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 20000 }); }
  finally { closeSync(fd); }
  const expected = await readFile(destination, 'utf8');
  assert.equal(file.status, status, `${entry} ${args.join(' ')}: ${file.stderr || expected.slice(0, 1000)}`);
  const report = JSON.parse(expected);
  if (args[0] === 'describe') assert.equal(report.verbs.verify.effects, effects);
  else if (args[0] === 'check') assert.ok(report.clauses.some(clause => !clause.ok));
  else assert.equal(report.diagnostics.missingInputs.length, 128);
  // A real OS pipe, with a consumer that reads to EOF before parsing. A file
  // redirect alone cannot expose short writes to a nonblocking pipe on macOS.
  const piped = await run('/bin/bash', ['-o', 'pipefail', '-c', '"$1" "$2" "${@:4}" | "$1" "$3"', 'rer-output', process.execPath, join(base, entry), consumer, ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 20000 }).catch(error => error);
  assert.equal(piped.code ?? 0, status, piped.stderr);
  assert.equal(piped.stdout, expected, `${entry} ${args.join(' ')}`);
 }
});
