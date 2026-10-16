// Use the same file glob and Node options as verify:modules, split across CI jobs.
import assert from 'node:assert/strict';
import { glob, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

export const MODULE_SHARDS = 6;

async function expandD1Wrapper(wrapper) {
  const source = await readFile(wrapper, 'utf8'), files = [];
  // This wrapper only collects independent suites. Refuse new executable code
  // instead of silently omitting behavior when CI runs its imports directly.
  const statement = /\s*import\s+(['"])(\.\/[\w./-]+\.test\.ts)\1\s*;/gy;
  let consumed = 0, match;
  while ((match = statement.exec(source))) {
    const file = join(dirname(wrapper), match[2]);
    assert.ok(file.startsWith(`${dirname(wrapper)}/d1/`), 'D1 wrapper imports must remain inside its d1 test directory');
    assert.ok((await stat(file)).isFile(), `D1 wrapper import is not a test file: ${file}`);
    files.push(file);
    consumed = statement.lastIndex;
  }
  assert.ok(files.length && !source.slice(consumed).trim(), 'D1 CI expansion requires a wrapper containing only static test imports');
  return files;
}

export async function moduleTestFiles() {
  const files = [];
  for await (const file of glob('modules/*/tests/*.test.ts')) files.push(file);
  const wrapper = 'modules/import-kit/tests/d1.test.ts';
  assert.ok(files.includes(wrapper), 'The D1 test wrapper must remain in the modules test inventory');
  const effective = files.filter(file => file !== wrapper).concat(await expandD1Wrapper(wrapper));
  assert.equal(effective.length, new Set(effective).size, 'Module CI must not repeat a test file');
  return effective.sort();
}

export async function verifyModuleShard(shard) {
  assert.match(shard ?? '', /^[1-6]$/, `MODULE_SHARD must be one of the ${MODULE_SHARDS} matrix shards`);
  const files = await moduleTestFiles();
  assert.ok(files.length >= MODULE_SHARDS, 'Each module shard must have test files');
  const started = performance.now();
  console.log(`VERIFY_STAGE start verify:modules shard=${shard}/${MODULE_SHARDS}`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:modules', '--', process.execPath,
    // The original wrapper initializes the public D1 entry in engine.test.ts
    // before its internal utility suites. Keep that context in each worker.
    '--import', './modules/import-kit/src/d1/index.ts',
    '--max-old-space-size=4096', '--test', '--test-concurrency=2', `--test-shard=${shard}/${MODULE_SHARDS}`, ...files,
  ], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    console.log(`VERIFY_STAGE end verify:modules shard=${shard}/${MODULE_SHARDS} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
