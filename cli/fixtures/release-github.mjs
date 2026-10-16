import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture } from '../../modules/release/test-fixture.mjs';
import { exportCLI } from '../export.mjs';
import { isolatedQueue } from './queue.mjs';

const base = resolve(import.meta.dirname, '../..');
export const repository = 'octocat/Hello-World';
const marker = name => `node -e "require('node:fs').writeFileSync(process.env.${name}, 'ran')"`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));

export async function source(t, { localPass = false, portable = false, buildFailure = false, declaration } = {}) {
  const f = fixture(t, `${marker('VERIFY_MARKER')} && node --test check.test.mjs${localPass ? '' : ' && node -e "process.exit(7)"'}`);
  const pkg = read(join(f.repo, 'package.json'));
  pkg.scripts.build = `node -e "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/bundle.js','export const released = true;')" && ${marker('BUILD_MARKER')}`;
  if (buildFailure) pkg.scripts.build += ' && node -e "process.exit(9)"';
  pkg.scripts['verify:release'] = `${marker('RELEASE_MARKER')}${localPass ? '' : ' && node -e "process.exit(8)"'}`;
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(f.repo, '.gitignore'), 'dist/\n');
  if (declaration !== undefined) {
    writeFileSync(join(f.repo, 'edition.json'), JSON.stringify({ id: repository }));
    writeFileSync(join(f.repo, 'rer-project.json'), JSON.stringify({ projectId: repository, sourceRepository: 'https://github.com/' + repository, ...declaration }));
  }
  f.sha = f.commit();
  execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', `git@github.com:${repository}.git`]);
  const commands = join(f.temporary, 'commands'); mkdirSync(commands);
  const responses = join(f.temporary, 'responses.json'), calls = join(f.temporary, 'calls.jsonl');
  writeFileSync(calls, '');
  const gh = join(commands, 'gh');
  // The only fake is GitHub's network boundary, shared with publication scan.
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2), path = args.at(-1);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
if (args.includes('--include')) { process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n{"private":false}'); }
else if (Object.hasOwn(responses, path)) { process.stdout.write(JSON.stringify(responses[path])); }
else { process.stderr.write('unexpected API request'); process.exitCode = 1; }
`);
  writeFileSync(join(commands, 'package.json'), '{"type":"commonjs"}'); chmodSync(gh, 0o755);
  const env = await isolatedQueue(t, { ...process.env, PATH: commands + ':' + process.env.PATH,
    BUILD_MARKER: join(f.temporary, 'built'), VERIFY_MARKER: join(f.temporary, 'verified'), RELEASE_MARKER: join(f.temporary, 'release-verified') });
  let cli = join(base, 'bin/rer.mjs');
  if (portable) {
    const target = join(f.temporary, 'portable'); await exportCLI(base, target);
    await cp(join(base, 'onboarding'), join(target, 'scripts/base-onboarding'), { recursive: true });
    cli = join(target, 'scripts/rer.mjs');
  }
  const run = { id: 12345, workflow_id: 42, head_sha: f.sha, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
  let attempt = 0;
  function invoke(runs = [run], flags = [], extra = {}) {
    writeFileSync(responses, JSON.stringify({
      [`repos/${repository}`]: { full_name: repository, default_branch: 'main' },
      [`repos/${repository}/actions/workflows?per_page=100`]: [{ workflows: [{ id: 42, name: 'Verify' }] }],
      [`repos/${repository}/actions/workflows/42/runs?head_sha=${f.sha}&per_page=100`]: [{ workflow_runs: runs }], ...extra,
    }));
    const output = join(f.temporary, 'release-' + attempt++);
    const result = spawnSync(process.execPath, [cli, 'release', '--repo', f.repo, '--project', repository,
      '--repository', 'https://github.com/' + repository, '--ref', f.sha, '--output', output, '--dry-run', ...flags],
    { cwd: f.temporary, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.stderr, '', result.stderr);
    return { result, receipt: JSON.parse(result.stdout), output };
  }
  return { ...f, env, calls, run, invoke };
}

