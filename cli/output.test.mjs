import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('large JSON reports drain through a full-reading pipe at both CLI entries', async t => {
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
 const env = { PATH: process.env.PATH, HOME: root, RER_NO_UPDATE_CHECK: '1' };
 for (const entry of ['bin/rer.mjs', 'global/rer.mjs']) for (const [args, status] of [
  [['describe', '--json'], 0],
  [['check', '--json', '--profile', 'first-party'], 1],
  [['doctor', '--json'], 3],
 ]) {
  const destination = join(root, 'description.json'), fd = openSync(destination, 'w');
  let file;
  try { file = spawnSync(process.execPath, [join(base, entry), ...args], { cwd: root, env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 20000 }); }
  finally { closeSync(fd); }
  assert.equal(file.status, status, file.stderr);
  const expected = await readFile(destination, 'utf8');
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
