import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
/** Verify the optional editor in a fresh native consumer of this committed Base. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../../..', import.meta.url));
const tests = fileURLToPath(new URL('.', import.meta.url));
const scratch = resolve(process.env.TMPDIR || join(base, '.editor-verification'));
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, 'editor-consumer-'));
const consumer = join(work, 'consumer');
const seed = join(consumer, 'default-seed');
const seedRequire = createRequire(join(base, 'default-seed/package.json'));
const wranglerRequire = createRequire(seedRequire.resolve('wrangler/package.json'));
const env = {
  ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false',
  RER_PLAYWRIGHT_MODULE: join(dirname(seedRequire.resolve('@playwright/test')), 'index.mjs'),
  RER_ESBUILD_MODULE: wranglerRequire.resolve('esbuild'),
  RER_NATIVE_CONSUMER_ROOT: seed,
  RER_EDITOR_EVIDENCE: join(work, 'evidence'),
};
const run = (command, args, cwd = base) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });
try {
  run(process.execPath, [join(tests, 'create-compiled-consumer.mjs'), consumer]);
  const disk = statfsSync(work);
  if (disk.bavail * disk.bsize < 15 * 1024 ** 3) throw new Error('Editor consumer install requires at least 15 GB free');
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], consumer);
  run('pnpm', ['typecheck'], seed);
  run('pnpm', ['build'], seed);
  run(process.execPath, ['--test', '--test-concurrency=1',
    join(tests, 'browser.test.mjs'), join(tests, 'session-rotation.browser.test.mjs'),
    join(tests, 'refresh.browser.test.mjs'),
    join(tests, 'compiled-native.browser.test.mjs'), join(tests, 'notfound-native.browser.test.mjs'),
    join(tests, 'template-consumer.browser.test.mjs')]);
  run(process.execPath, [join(tests, 'consumer-browser.mjs'), seed]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
