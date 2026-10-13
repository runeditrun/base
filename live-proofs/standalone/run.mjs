import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runtimeImages } from '../t016/isolation.mjs';
import { requireIsolation } from '../t016/trust-boundary.mjs';
import { runBrowser } from '../t016/browser-runner.mjs';
import { runProcess } from '../t016/process.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
import { healthAndWidget, hostedOrigin } from '../../scripts/qualification/http.mjs';
import { reviewedExecutor } from './executor.mjs';

const control = fileURLToPath(new URL('../../', import.meta.url));
export async function runStandalone(options, supplied = process.env) {
  insist(supplied.GITHUB_ACTIONS === 'true' && supplied.GITHUB_REPOSITORY === 'runeditrun/base' &&
    supplied.GITHUB_REF === 'refs/heads/main' && supplied.GITHUB_EVENT_NAME === 'workflow_dispatch', 'live-environment-required');
  const images = runtimeImages(supplied); requireIsolation(supplied, images);
  hostedOrigin(options.origin);
  insist(/^[a-z][a-z0-9-]*$/.test(options.seed ?? '') && /^[a-z][a-z0-9-]*$/.test(options.adapter ?? ''), 'invalid-adapter');
  let root, deployment;
  try {
    root = mkdtempSync(join(supplied.RUNNER_TEMP, 'standalone-')); mkdirSync(join(root, 'home'));
    const env = { PATH: supplied.PATH, HOME: join(root, 'home'), TMPDIR: root, RUNNER_TEMP: root,
      T016_CONTAINER_LABEL: 't016-generic-' + randomBytes(12).toString('hex'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    // Adapter code is reviewed Base code, never code loaded from --directory.
    // Bind the checked-out controller and adapter bytes to the isolation gate.
    const git = args => runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: control, env });
    const revision = await git(['rev-parse', 'HEAD']);
    insist(revision.exitCode === 0 && revision.output.toString().trim() === supplied.CONTROL_SHA, 'controller-source-mismatch');
    const clean = await git(['status', '--porcelain', '--untracked-files=all']);
    insist(clean.exitCode === 0 && clean.output.length === 0, 'controller-source-mismatch');
    const path = `live-proofs/standalone/adapters/${options.adapter}.mjs`;
    const tracked = await git(['ls-files', '--error-unmatch', '--', path]);
    insist(tracked.exitCode === 0, 'reviewed-adapter-unconfigured');
    const module = realpathSync(join(control, path));
    insist(relative(realpathSync(control), module) === path, 'adapter-outside-controller');
    const { adapter } = await import(pathToFileURL(module).href);
    insist(adapter.seed === options.seed, 'adapter-seed-mismatch');
    deployment = await reviewedExecutor({ directory: realpathSync(options.directory), adapter, env, inputs: supplied, origin: options.origin, root, images,
      remoteSelection: options.target === 'remote' ? { from: '--local', to: '--remote' } : undefined });
    const commands = [];
    for (const command of deployment.commands) {
      const result = await deployment.execute(command); insist(result.exitCode === 0, command.name + '-failed');
      commands.push({ ...command, result });
    }
    insist(deployment.artifacts.length > 0, 'missing-build-artifact');
    await healthAndWidget(options.origin, deployment.descriptor, options.widgetPath);
    const artifacts = deployment.artifacts;
    await deployment.close(); deployment = null;
    await adapter.qualify({ origin: options.origin, env: Object.fromEntries(adapter.journeyEnvironment.map(name => [name, supplied[name]])),
      commands, artifacts, browser: input => runBrowser(input, { env, image: images.browser }) });
    return { result: 'passed', seed: options.seed, sourceSha: adapter.sourceSha, controllerSha: supplied.CONTROL_SHA };
  } finally {
    try { if (deployment) await deployment.close(); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); }
  }
}
