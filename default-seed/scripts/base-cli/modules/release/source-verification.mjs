import { command, git } from './source.mjs';
import { githubSource, githubVerify } from './github-verify.mjs';

export async function verifySource(source, checkout, localVerify) {
  const repository = localVerify ? null : githubSource(source);
  const verify = repository ? githubVerify(source, repository) : null;
  // Refuse missing CI evidence before spending time installing or building.
  if (verify?.status === 'FAIL') return verify;
  const install = await command('pnpm', ['install', '--frozen-lockfile'], checkout, { dependencies: true });
  if (verify) {
    verify.install = install;
    if (install.status !== 'PASS') {
      verify.status = 'FAIL'; verify.reason = 'frozen-install-failed';
    } else {
      const scripts = JSON.parse(source.bytes('package.json')).scripts;
      verify.build = scripts.build ? await command('pnpm', ['run', 'build'], checkout)
        : { status: 'PASS', skipped: true, reason: 'no-build-script' };
      if (verify.build.status !== 'PASS') { verify.status = 'FAIL'; verify.reason = 'release-build-failed'; }
    }
  }
  const result = verify ?? (install.status === 'PASS' ? await command('pnpm', ['run', 'verify'], checkout)
    : { status: 'FAIL', reason: 'frozen-install-failed', tests: 0, passed: 0, failed: 0, output: install.output });
  // --local-verify preserves both of the seed's existing verification targets.
  if (!verify && result.status === 'PASS' && JSON.parse(source.bytes('package.json')).scripts['verify:release']) {
    result.release = await command('pnpm', ['run', 'verify:release'], checkout);
    if (result.release.status !== 'PASS') {
      result.status = 'FAIL'; result.exitCode = result.release.exitCode;
      result.reason = 'release-verification-failed';
    }
  }
  if (git(checkout, 'status', '--porcelain', '--untracked-files=no').length) {
    result.status = 'FAIL'; result.reason = 'verify-changed-tracked-source';
  }
  return result;
}
