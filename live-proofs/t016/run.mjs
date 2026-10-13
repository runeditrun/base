import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquirePublic, git } from './source.mjs';
import { publicSource, t016Proofs, secretsFor } from './profile.mjs';
import { selectTarget, deploymentIdentity, databaseReader, r2DisabledReadback } from './cloudflare.mjs';
import { readOperations, resolveCommand, digest, insist } from '../../scripts/qualification/operations.mjs';
import { healthAndWidget } from '../../scripts/qualification/http.mjs';
import { widgetPath, claimAndReply, sendAndReadMail } from '../../scripts/qualification/happytohelp.mjs';
import { observation, failureCodes } from './facts.mjs';
import { runtimeImages, isolatedDeployment } from './isolation.mjs';
import { requireIsolation } from './trust-boundary.mjs';
import { runBrowser } from './browser-runner.mjs';
import { migrationBytes, snapshotState, recheckState } from './state.mjs';

const remoteSelection = { from: '--local', to: '--remote' };
export async function runT016(proof, supplied = process.env) {
  insist(Object.hasOwn(t016Proofs, proof), 'unknown-proof');
  const observations = [], commands = [];
  let root, failure = null, sourceSha = proof === 't016-upgrade-rollback' ? publicSource.previousSha : publicSource.sha;
  let deployment;
  const observe = (phase,facts,passed = true) => observations.push(observation(phase,facts,passed));
  const record = (argv,result,sha = sourceSha,boundary = 'source') => commands.push({ argv, cwd: boundary === 'source' ? result.cwd : '/seed', sourceSha: sha, boundary,
    startedUtc: result.startedUtc, finishedUtc: result.finishedUtc, exitCode: result.exitCode, outputSha256: result.outputHash });
  try {
    insist(supplied.GITHUB_ACTIONS === 'true' && supplied.GITHUB_REPOSITORY === 'runeditrun/base' &&
      supplied.GITHUB_REF === 'refs/heads/main' && supplied.GITHUB_EVENT_NAME === 'workflow_dispatch', 'live-environment-required');
    insist(secretsFor(proof,supplied.T016_MAILBOX_ADAPTER).every(name => supplied[name]?.trim()), 'missing-secret');
    if (proof !== 't016-r2-off') {
      insist(supplied.T016_MAILBOX_ADAPTER, 'mailbox-choice-pending');
      insist(supplied.T016_MAILBOX_ADAPTER === 'gmail', 'mailbox-adapter-unsupported');
    }
    const images = runtimeImages(supplied); requireIsolation(supplied,images);
    observe('isolation',{ controllerSha: supplied.CONTROL_SHA, attestation: supplied.T016_ISOLATION_ATTESTATION,
      controllerImage: images.controller, buildImage: images.build, browserImage: images.browser });
    insist(Number(process.versions.node.split('.')[0]) >= 26, 'node-26-required');
    insist(/^[1-9][0-9]{0,19}$/.test(supplied.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,19}$/.test(supplied.GITHUB_RUN_ATTEMPT ?? ''), 'invalid-run');
    root = mkdtempSync(join(supplied.RUNNER_TEMP,'t016-')); const home = join(root,'home'); mkdirSync(home);
    const clean = { PATH: supplied.PATH, HOME: home, TMPDIR: root, RUNNER_TEMP: root, CI: 'true',
      T016_CONTAINER_LABEL: `t016-${supplied.GITHUB_RUN_ID}-${supplied.GITHUB_RUN_ATTEMPT}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Standalone qualification', GIT_AUTHOR_EMAIL: 'qualification@runeditrun.invalid',
      GIT_COMMITTER_NAME: 'Standalone qualification', GIT_COMMITTER_EMAIL: 'qualification@runeditrun.invalid' };
    const source = acquirePublic(root,clean,proof === 't016-upgrade-rollback',record);
    const env = { ...clean, CLOUDFLARE_API_TOKEN: supplied.CF_THROWAWAY_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: supplied.CF_THROWAWAY_ACCOUNT_ID,
      H2H_RESOURCE_PREFIX: `t016-${supplied.GITHUB_RUN_ID}-${supplied.GITHUB_RUN_ATTEMPT}`, H2H_SETUP_TOKEN: randomBytes(32).toString('hex'),
      REGISTRATION_ENABLED: 'false' };
    env.H2H_PUBLIC_ORIGIN = await selectTarget(env,env.H2H_RESOURCE_PREFIX);
    observe('target',{ origin: env.H2H_PUBLIC_ORIGIN, worker: env.H2H_RESOURCE_PREFIX });
    if (proof !== 't016-r2-off') Object.assign(env,{ EMAIL_PROVIDER: 'sendgrid', EMAIL_API_KEY: supplied.T016_SENDGRID_API_KEY, EMAIL_FROM: supplied.T016_SENDGRID_FROM });
    let config;
    const publish = async stage => {
      const migrations = migrationBytes(source.cwd);
      observe('source',{ sourceSha, documentsSha256: digest(['OPERATIONS.json','OPERATIONS.md','ACCEPTANCE.md','docs/INSTALLER.md'].map(path => [path,digest(readFileSync(join(source.cwd,path)))])),
        migrationsSha256: digest(migrations), release: JSON.parse(readFileSync(join(source.cwd,'package.json'))).version });
      const descriptor = readOperations(source.cwd);
      const setup = resolveCommand(descriptor,'setup',remoteSelection), deploy = resolveCommand(descriptor,'deploy',remoteSelection);
      deployment = await isolatedDeployment({ source: source.cwd, sourceSha, env, root, images, record, observe });
      if (proof === 't016-r2-off') observe('r2',await r2DisabledReadback(env));
      const prepared = await deployment.execute(setup);
      if (proof === 't016-r2-off') {
        insist(prepared.exitCode !== 0,'r2-disabled-setup-unexpectedly-passed'); throw new Error('r2-disabled-confirmed');
      }
      insist(prepared.exitCode === 0,'setup-failed'); config = await deployment.readConfig();
      const database = config.d1_databases.find(x => x.binding === 'DB');
      observe('setup',{ stage, databaseId: database.database_id, databaseName: database.database_name,
        worker: env.H2H_RESOURCE_PREFIX, bucket: config.r2_buckets.find(x => x.binding === 'FILES').bucket_name,
        queues: [...new Set(config.queues.producers.map(x => x.queue))].sort() });
      const result = await deployment.execute(deploy); insist(result.exitCode === 0,'deploy-failed');
      const serving = await deploymentIdentity(env,{ output: result.output.toString(), artifact: deployment.artifact(), stage });
      observe('deploy',serving);
      const { health } = await healthAndWidget(env.H2H_PUBLIC_ORIGIN,descriptor,widgetPath);
      insist(health.database === 'reachable' && health.files === 'reachable','health-readback-failed');
      observe('health',{ stage, origin: env.H2H_PUBLIC_ORIGIN, database: health.database, files: health.files });
      await deployment.close(); deployment = null;
      return { serving,migrations };
    };
    const initial = await publish('initial');
    const browser = input => runBrowser(input,{ env: clean,image: images.browser });
    const journeyEnv = { H2H_SETUP_TOKEN: env.H2H_SETUP_TOKEN, T016_TEST_MAILBOX: supplied.T016_TEST_MAILBOX,
      T016_SENDGRID_FROM: supplied.T016_SENDGRID_FROM, T016_MAILBOX_ADAPTER: supplied.T016_MAILBOX_ADAPTER, T016_GMAIL_ACCESS_TOKEN: supplied.T016_GMAIL_ACCESS_TOKEN };
    const state = await claimAndReply({ origin: env.H2H_PUBLIC_ORIGIN,env: journeyEnv,observe,browser });
    const read = databaseReader(config,env);
    await sendAndReadMail({ origin: env.H2H_PUBLIC_ORIGIN,env: journeyEnv,state,observe,
      deliveryReadback: async key => (await read('SELECT state, provider_id FROM email_deliveries WHERE id=?',[key]))[0] ?? {} });
    const before = await snapshotState({ read,state,origin: env.H2H_PUBLIC_ORIGIN,migrations: initial.migrations });
    const migrationObservation = (stage,snapshot) => observe('migrations',{ stage, ledgerSha256: snapshot.ledgerSha256,
      sourceMigrationsSha256: snapshot.sourceMigrationsSha256,names: snapshot.names });
    migrationObservation('initial',before);
    if (proof === 't016-upgrade-rollback') {
      git(source.cwd,['merge','--no-edit',publicSource.ref],clean,record);
      sourceSha = git(source.cwd,['rev-parse','HEAD'],clean,record); insist(sourceSha === publicSource.sha,'upgrade-source-mismatch');
      const upgraded = await publish('upgrade');
      const after = await recheckState({ before,read,state,origin: env.H2H_PUBLIC_ORIGIN,migrations: upgraded.migrations,previousMigrations: initial.migrations,browser });
      migrationObservation('upgrade',after);
      observe('upgrade',{ sourceSha, previousVersionId: initial.serving.versionId, versionId: upgraded.serving.versionId,
        rowsSha256: after.rowsSha256, mediaSha256: after.mediaSha256, ledgerSha256: after.ledgerSha256, loginVerified: true });
      git(source.cwd,['checkout','--detach',publicSource.previousSha],clean,record); sourceSha = publicSource.previousSha;
      const rolledBack = await publish('rollback');
      const retained = await recheckState({ before: after,read,state,origin: env.H2H_PUBLIC_ORIGIN,migrations: rolledBack.migrations,previousMigrations: upgraded.migrations,browser });
      migrationObservation('rollback',retained);
      observe('rollback',{ sourceSha, previousVersionId: upgraded.serving.versionId, versionId: rolledBack.serving.versionId,
        rowsSha256: retained.rowsSha256, mediaSha256: retained.mediaSha256, ledgerSha256: retained.ledgerSha256, loginVerified: true });
    }
  } catch (error) {
    failure = failureCodes.includes(error.message) ? error.message : 'qualification-failed';
    observe('boundary',{ code: failure },false);
  } finally {
    if (deployment) { try { await deployment.close(); } catch { failure = 'qualification-failed'; observe('boundary',{ code: failure },false); } }
    if (root) rmSync(root,{ recursive: true,force: true });
  }
  return { version: 2,proof,publicSource,commands,observations,failure,result: failure ? 'failed' : 'passed' };
}
