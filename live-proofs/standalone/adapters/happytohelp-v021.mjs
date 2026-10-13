import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildIdentity } from '../../t016/artifact.mjs';
import { databaseReader, deploymentIdentity } from '../../t016/cloudflare.mjs';
import { snapshotState } from '../../t016/state.mjs';
import { observation } from '../../t016/facts.mjs';
import { claimAndReply, sendAndReadMail } from '../../../scripts/qualification/happytohelp.mjs';
import { insist } from '../../../scripts/qualification/operations.mjs';

const pin = JSON.parse(readFileSync(new URL('./happytohelp-v021.json', import.meta.url)));
const deploymentEnvironment = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'H2H_RESOURCE_PREFIX', 'H2H_PUBLIC_ORIGIN',
  'H2H_SETUP_TOKEN', 'REGISTRATION_ENABLED', 'EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM'];
const mailEnvironment = ['MAILBOX_ADAPTER', 'TEST_MAILBOX', 'GMAIL_READONLY_TOKEN'];
let prepared, artifact;
export const adapter = {
  ...pin, seed: 'happytohelp', requiredEnvironment: [...deploymentEnvironment, ...mailEnvironment], deploymentEnvironment,
  journeyEnvironment: [...deploymentEnvironment, ...mailEnvironment],
  validateInputs(env, { origin }) {
    insist(origin === env.H2H_PUBLIC_ORIGIN, 'hosted-origin-mismatch');
    insist(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID) && /^t016-[0-9]+-[0-9]+$/.test(env.H2H_RESOURCE_PREFIX) &&
      new URL(env.H2H_PUBLIC_ORIGIN).hostname.startsWith(env.H2H_RESOURCE_PREFIX + '.') &&
      new URL(env.H2H_PUBLIC_ORIGIN).hostname.endsWith('.workers.dev'), 'invalid-throwaway-target');
    insist(env.H2H_SETUP_TOKEN.length >= 32 && env.REGISTRATION_ENABLED === 'false' &&
      env.EMAIL_PROVIDER === 'sendgrid' && env.MAILBOX_ADAPTER === 'gmail', 'unconfigured-happytohelp-proof');
  },
  builds: [{ argv: ['pnpm', 'build'], cwd: '.', install: [['pnpm', 'install', '--frozen-lockfile']], output: 'dist',
    publicEnvironment: ['CLOUDFLARE_ACCOUNT_ID', 'H2H_RESOURCE_PREFIX', 'H2H_PUBLIC_ORIGIN', 'REGISTRATION_ENABLED', 'EMAIL_PROVIDER'],
    environment: inputs => ({ ...inputs, H2H_WRANGLER_CONFIG: `/seed/.seed/deployment/${inputs.H2H_RESOURCE_PREFIX}/wrangler.json` }) }],
  tools: { pnpm: { path: '/opt/trusted/bin/pnpm', allow: ['d1', 'r2', 'queues', 'deploy', 'whoami'].map(command => ['exec', 'wrangler', command]) } },
  async prepareBuild({ publicInputs, readFile }) {
    const path = `.seed/deployment/${publicInputs.H2H_RESOURCE_PREFIX}/wrangler.json`, bytes = await readFile(path);
    prepared = JSON.parse(bytes.toString()); return [{ path, bytes }];
  },
  async validateArtifact({ root, files }) { artifact = buildIdentity({ root, files, prepared, sourceSha: pin.sourceSha }); },
  async qualify({ origin, env, commands, browser }) {
    insist(origin === env.H2H_PUBLIC_ORIGIN, 'hosted-origin-mismatch');
    const deployed = commands.find(command => command.name === 'deploy');
    await deploymentIdentity(env, { output: deployed.result.output.toString(), artifact, stage: 'initial' });
    const journeyEnv = { H2H_SETUP_TOKEN: env.H2H_SETUP_TOKEN, T016_TEST_MAILBOX: env.TEST_MAILBOX,
      T016_SENDGRID_FROM: env.EMAIL_FROM, T016_MAILBOX_ADAPTER: env.MAILBOX_ADAPTER, T016_GMAIL_ACCESS_TOKEN: env.GMAIL_READONLY_TOKEN };
    const observations = [], observe = (phase, facts) => observations.push(observation(phase, facts));
    const state = await claimAndReply({ origin, env: journeyEnv, observe, browser });
    const read = databaseReader(prepared, env);
    await sendAndReadMail({ origin, env: journeyEnv, state, observe,
      deliveryReadback: async key => (await read('SELECT state, provider_id FROM email_deliveries WHERE id=?', [key]))[0] ?? {} });
    const migrations = Object.entries(pin.controllerFiles).filter(([path]) => path.endsWith('.sql'))
      .map(([path, sha256]) => ({ name: basename(path), sha256 })).sort((a, b) => a.name.localeCompare(b.name));
    await snapshotState({ read, state, origin, migrations });
    return { observations };
  },
};
