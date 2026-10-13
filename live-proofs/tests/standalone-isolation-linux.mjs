// Provider-free real Linux integration check. No fake executor or Docker mock.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { standaloneFixture } from './standalone-fixture.mjs';
import { reviewedExecutor } from '../standalone/executor.mjs';
import { runtimeImages } from '../t016/isolation.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
insist(process.platform === 'linux', 'linux-gate-required');
const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'standalone-linux-'));
let deployment;
try {
  const fixture = standaloneFixture(root), work = join(root, 'work'); mkdirSync(work);
  deployment = await reviewedExecutor({ ...fixture, root: work, images: runtimeImages(process.env), inputs: { PROVIDER_TOKEN: randomBytes(32).toString('hex') } });
  for (const command of deployment.commands) {
    const result = await deployment.execute(command); insist(result.exitCode === 0, command.name + '-failed');
    if (command.name === 'deploy') insist(result.output.toString().includes('literal-deployment-completed'), 'fixture-public-command-did-not-complete');
  }
  insist(deployment.artifacts.length === 1, 'missing-build-artifact');
  console.log('Real Linux generic executor: declared credential, literal shell/cwd, isolated install/build, verified artifact and controller completion passed.');
} finally {
  try { if (deployment) await deployment.close(); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
