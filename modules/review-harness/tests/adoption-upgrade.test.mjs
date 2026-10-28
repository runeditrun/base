import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { temporary, root } from './helpers.mjs';
import { toolFiles } from '../../../edition-authoring/files.mjs';

const execute = promisify(execFile);
test('README upgrades edition-authoring before provenance; its capability preflight rejects old tools', async t => {
  const readme = await readFile(join(import.meta.dirname, '../README.md'), 'utf8');
  assert.match(readme, /upgrade older seeds'[\s\S]*edition-authoring tool/);
  assert.match(readme, /\]\(\.\.\/\.\.\/edition-authoring\/README\.md\)/);
  const fence = readme.match(/<!-- adoption-preflight -->\s*```sh\n([\s\S]*?)\n```/);
  assert.ok(fence, 'adoption has an executable capability preflight');
  assert.ok(readme.indexOf('<!-- adoption-preflight -->') < readme.indexOf('node scripts/edition-authoring/cli.mjs record-base'));
  const directory = await temporary(t), tool = join(directory, 'scripts/edition-authoring');
  await mkdir(tool, { recursive: true });
  const probe = join(directory, 'preflight.sh');
  await writeFile(probe, fence[1]);
  for (const commands of ['inspect|lock|check', 'inspect|record-base', 'inspect|verify-base']) {
    // Old and incomplete usage surfaces are test-only inputs.
    await writeFile(join(tool, 'cli.mjs'), `console.error('Usage: cli.mjs ${commands}'); process.exitCode=1;`);
    await assert.rejects(execute('bash', [probe], { cwd: directory }), error => error.code === 1 && /Upgrade the complete edition-authoring tool/.test(error.stderr));
  }
  const baseTool = join(root, 'edition-authoring');
  for (const file of toolFiles(baseTool)) {
    await mkdir(dirname(join(tool, file)), { recursive: true });
    await copyFile(join(baseTool, file), join(tool, file));
  }
  const result = await execute('bash', [probe], { cwd: directory });
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /supports record-base and verify-base/);
});
