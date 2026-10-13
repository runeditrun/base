import { publicSource, t016Proofs } from './profile.mjs';
import { insist, digest } from '../../scripts/qualification/operations.mjs';
import { validateFacts, hash, sha, utc, failureCodes } from './facts.mjs';
import { isolationAttestation } from './trust-boundary.mjs';

const allowed = argv => {
  const text = JSON.stringify(argv);
  if ([['pnpm','install','--frozen-lockfile'], ['pnpm','build'],
    ...['setup','deploy'].map(name => ['pnpm','run',name,'--','--remote'])].some(x => JSON.stringify(x) === text)) return true;
  const git = args => JSON.stringify(['git','-c','core.hooksPath=/dev/null',...args]) === text;
  return git(['clone','--no-checkout','--no-tags',publicSource.repository,'seed']) ||
    [publicSource.ref, publicSource.previousRef].some(ref => git(['fetch','--no-tags','origin',`refs/tags/${ref}:refs/tags/${ref}`]) || git(['rev-parse', ref+'^{commit}'])) ||
    [publicSource.sha,publicSource.previousSha].some(value => git(['checkout','--detach',value])) ||
    git(['merge','--no-edit',publicSource.ref]) || git(['rev-parse','HEAD']);
};
const exact = (value, keys) => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());
export function validateQualification(value, proof) {
  insist(Object.hasOwn(t016Proofs, proof) && exact(value, ['version','proof','publicSource','commands','observations','failure','result']), 'invalid-qualification-schema');
  insist(value.version === 2 && value.proof === proof && JSON.stringify(value.publicSource) === JSON.stringify(publicSource), 'invalid-qualification-source');
  insist((value.failure === null || failureCodes.includes(value.failure)) && value.result === (value.failure ? 'failed' : 'passed'), 'invalid-qualification-result');
  insist(Array.isArray(value.commands) && value.commands.length <= 60, 'invalid-commands');
  for (const c of value.commands) insist(exact(c, ['argv','cwd','sourceSha','boundary','startedUtc','finishedUtc','exitCode','outputSha256']) &&
    Array.isArray(c.argv) && allowed(c.argv) && sha(c.sourceSha) &&
    typeof c.cwd === 'string' && /^\/[A-Za-z0-9_./-]{1,500}$/.test(c.cwd) &&
    (c.boundary === 'source' || c.cwd === '/seed') &&
    [publicSource.sha,publicSource.previousSha].includes(c.sourceSha) && ['source','isolated-build','trusted-controller'].includes(c.boundary) &&
    utc(c.startedUtc) && utc(c.finishedUtc) && c.finishedUtc >= c.startedUtc && Number.isInteger(c.exitCode) && c.exitCode >= -1 && c.exitCode <= 255 && hash(c.outputSha256), 'invalid-command-receipt');
  insist(Array.isArray(value.observations) && value.observations.length > 0 && value.observations.length <= 80, 'invalid-observations');
  for (const item of value.observations) {
    insist(exact(item, ['phase','passed','facts','sha256','utc']) && typeof item.passed === 'boolean' && utc(item.utc), 'invalid-observation');
    validateFacts(item.phase, item.facts); insist(item.sha256 === digest(item.facts), 'observation-digest-mismatch');
    if (item.phase === 'isolation') {
      const facts = item.facts;
      insist(facts.attestation === isolationAttestation({ controller: facts.controllerImage, build: facts.buildImage,
        browser: facts.browserImage },facts.controllerSha), 'invalid-isolation-provenance');
    }
  }
  if (value.result === 'passed') {
    const required = ['isolation','source','dependencies','target','setup','build','deploy','health','widget','owner','reply','media','sendgrid','mailbox','migrations'];
    if (proof === 't016-upgrade-rollback') required.push('upgrade','rollback');
    insist(proof !== 't016-r2-off' && value.observations.every(x => x.passed) && value.commands.every(x => x.exitCode === 0) &&
      required.every(phase => value.observations.some(x => x.phase === phase)), 'incomplete-proof');
    const events = phase => value.observations.filter(x => x.phase === phase).map(x => x.facts);
    const deployments = events('deploy');
    insist(deployments.length === (proof === 't016-upgrade-rollback' ? 3 : 1) &&
      new Set(deployments.map(x => x.versionId)).size === deployments.length &&
      new Set(deployments.map(x => x.deploymentId)).size === deployments.length, 'deployment-identities-not-distinct');
    for (const deployment of deployments) {
      insist(events('source').some(source => source.sourceSha === deployment.sourceSha) &&
        events('dependencies').some(dependencies => dependencies.sourceSha === deployment.sourceSha), 'missing-release-provenance');
      insist(events('build').some(build => build.sourceSha === deployment.sourceSha && build.artifactSha256 === deployment.artifactSha256 && build.workerSha256 === deployment.workerSha256), 'unbound-deployment');
      insist(value.commands.some(c => c.sourceSha === deployment.sourceSha && c.boundary === 'isolated-build' &&
        JSON.stringify(c.argv) === JSON.stringify(['pnpm','install','--frozen-lockfile'])) &&
        value.commands.some(c => c.sourceSha === deployment.sourceSha && c.boundary === 'isolated-build' &&
        JSON.stringify(c.argv) === JSON.stringify(['pnpm','build'])), 'missing-isolated-build');
      insist(['setup','deploy'].every(name => value.commands.some(c => c.sourceSha === deployment.sourceSha && c.boundary === 'trusted-controller' &&
        JSON.stringify(c.argv) === JSON.stringify(['pnpm','run',name,'--','--remote']))), 'missing-public-command');
    }
    if (proof === 't016-r2-on') insist(deployments[0].stage === 'initial' && deployments[0].sourceSha === publicSource.sha, 'wrong-public-release');
    insist(events('sendgrid').some(sent => events('mailbox').some(mail => mail.correlation === sent.correlation)), 'uncorrelated-mailbox');
    if (proof === 't016-upgrade-rollback') {
      insist(deployments.map(x => x.stage).join() === 'initial,upgrade,rollback' &&
        deployments.map(x => x.sourceSha).join() === [publicSource.previousSha,publicSource.sha,publicSource.previousSha].join(), 'invalid-release-transition');
      for (const [index, phase] of [[1,'upgrade'],[2,'rollback']]) insist(events(phase).some(x =>
        x.sourceSha === deployments[index].sourceSha && x.previousVersionId === deployments[index-1].versionId && x.versionId === deployments[index].versionId), 'unbound-transition');
    }
  }
  return value;
}
