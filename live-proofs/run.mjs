import { spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './git.mjs';
import { proofs, providerSecrets, requireProof, requireSha } from './policy.mjs';
import { stage } from './stage-adapter.mjs';

export function execute({ root, sha, mode, proof, env = process.env, adapter = stage }) {
  requireSha(sha);
  if (git(root, ['rev-parse', 'HEAD']).text !== sha) throw new Error('checkout-mismatch');
  const childEnv = { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, CI: 'true',
    ...Object.fromEntries(providerSecrets.map(name => [name, env[name] ?? ''])) };
  // Output of arbitrary proof/deploy processes is discarded, never forwarded to
  // logs or evidence. secrets-present names are emitted by this trusted harness.
  const invoke = (argv, cwd) => {
    if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string' || !x || x.includes('\0')))
      throw new Error('invalid-adapter');
    return spawnSync(argv[0], argv.slice(1), { cwd, env: childEnv,
      stdio: 'ignore', timeout: 15 * 60 * 1000 }).status === 0;
  };
  if (mode === 'proof') {
    requireProof(proof);
    if (proof.startsWith('t016-')) throw new Error('trusted-async-runner-required');
    for (const name of providerSecrets) if (childEnv[name].trim()) console.log(name);
    if (providerSecrets.some(name => !childEnv[name].trim())) return 'missing-secret';
    return invoke(proofs[proof], root) ? 'passed' : 'proof-failed';
  }
  if (mode !== 'stage') throw new Error('invalid-mode');
  if (adapter.blocked) return 'stage-target-unconfigured';
  if (providerSecrets.some(name => !childEnv[name].trim())) return 'missing-secret';
  const cwd = realpathSync(resolve(root, adapter.cwd));
  if (relative(realpathSync(root), cwd).startsWith('..')) throw new Error('invalid-adapter');
  if (!invoke(adapter.deploy, cwd)) return 'deploy-failed';
  return invoke(adapter.health, cwd) ? 'passed' : 'health-failed';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result = 'execution-failed';
  let executedSha = '';
  const started = new Date().toISOString();
  let qualification = '';
  try {
    if (git(process.env.SOURCE_DIRECTORY, ['rev-parse', 'HEAD']).text === requireSha(process.env.VALIDATED_SHA))
      executedSha = process.env.VALIDATED_SHA;
    if (process.env.MODE === 'proof' && process.env.INPUT_PROOF?.startsWith('t016-')) {
      requireProof(process.env.INPUT_PROOF);
      if (!executedSha || executedSha !== requireSha(process.env.CONTROL_SHA)) throw new Error('controller-source-mismatch');
      const { validateQualification } = await import('./t016/observations.mjs');
      const cwd = new URL('..', import.meta.url).pathname;
      const argv = process.env.INPUT_PROOF === 't016-r2-on'
        ? ['scripts/qualify-standalone.mjs', '--seed', 'happytohelp']
        : [proofs[process.env.INPUT_PROOF][1]];
      const child = spawnSync(process.execPath, argv, { cwd, env: process.env, encoding: 'utf8',
        maxBuffer: 1024 * 1024, timeout: 55 * 60 * 1000 });
      const report = validateQualification(JSON.parse(child.stdout || '{}'), process.env.INPUT_PROOF);
      if ((report.result === 'passed') !== (child.status === 0)) throw new Error('qualification-exit-mismatch');
      qualification = JSON.stringify(report);
      result = report.result === 'passed' ? 'passed' : report.failure === 'missing-secret' ? 'missing-secret' : 'proof-failed';
    } else result = execute({ root: process.env.SOURCE_DIRECTORY, sha: process.env.VALIDATED_SHA,
      mode: process.env.MODE, proof: process.env.INPUT_PROOF }); } catch { /* fixed status only */ }
  appendFileSync(process.env.GITHUB_OUTPUT,
    `result=${result}\nexecuted_sha=${executedSha}\nstarted=${started}\nfinished=${new Date().toISOString()}\nqualification=${qualification}\n`);
  if (result !== 'passed') process.exitCode = 1;
}
