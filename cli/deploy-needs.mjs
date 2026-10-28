import { invalid } from './errors.mjs';

export const cloudflareCredentials = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const tokenPage = 'https://dash.cloudflare.com/profile/api-tokens';
// The account permissions the deploy kit's requests need, by what the declaration uses.
const permissions = [
 ['Workers Scripts: Edit', () => true],
 ['D1: Edit', declaration => declaration.d1?.length],
 ['Workers R2 Storage: Edit', declaration => declaration.r2?.length],
 ['Workers KV Storage: Edit', declaration => declaration.kv?.length],
 ['Queues: Edit', declaration => declaration.queues?.length],
];

// A project may name its own deploy guide in deploy.json: an https page a stranger can open.
export function deployGuide(declaration) {
 const value = declaration?.deployGuide;
 if (value === undefined) return undefined;
 let url;
 try { url = new URL(value); } catch {}
 if (typeof value !== 'string' || url?.protocol !== 'https:' || url.username || url.password) throw invalid('deploy.json deployGuide must be an https URL of the project\'s deploy guide, without credentials.');
 return value;
}

/** The account permissions an API token needs to deploy this declaration (the run site's /docs/hosting lists the same). */
export const deployPermissions = declaration => permissions.filter(([, used]) => used(declaration)).map(([name]) => name);

// Where a person gets the Cloudflare values: the project's guide, else the token page and the permissions.
function credentialHelp(declaration) {
 const guide = deployGuide(declaration);
 if (guide) return [`Follow this project's deploy guide: ${guide}`];
 return [`Create an account API token at ${tokenPage} with these account permissions: ${deployPermissions(declaration).join(', ')}. Copy your account ID from the Cloudflare dashboard.`];
}

export function missingCredentialsMessage(declaration, env, { dryRun = false, signIn } = {}) {
 const absent = cloudflareCredentials.filter(name => !env[name]?.trim());
 return [...(dryRun ? ['Dry run cannot read the target secret bindings without Cloudflare credentials.'] : []),
  `${absent.join(' and ')} ${absent.length > 1 ? 'are' : 'is'} required to deploy to your Cloudflare account. Nothing was deployed.`,
  ...credentialHelp(declaration),
  'Set them in your environment or an owned 0600 --env-file, then run the same deploy command again.',
  ...(dryRun ? ['Needed for a real deploy (the dry run could not check the target):', ...neededForRealDeploy({declaration,env,signIn}).map(item => `  - ${item}`)] : [])].join('\n');
}

// Setup guidance and failed dry-run inputs. After target resolution, held
// secrets no longer count as missing local inputs.
export function neededForRealDeploy({ declaration, env, signIn, secretsChecked = false }) {
 const declared = (Array.isArray(declaration.secrets) ? declaration.secrets : []).filter(item => item?.environment);
 // Sign-in names its inputs by binding; a person sets the environment name the declaration maps to it.
 const mail = signIn && declared.reduce((text, item) => item.binding === item.environment ? text : text.replace(new RegExp(`\\b${item.binding}\\b`, 'g'), item.environment), signIn);
 const listed = name => cloudflareCredentials.includes(name) || mail && new RegExp(`\\b${name}\\b`).test(mail);
 const secrets = secretsChecked ? [] : [...new Set(declared.filter(item => !item.optional && !env[item.environment]?.trim()).map(item => item.environment))].filter(name => !listed(name));
 const credentials = secretsChecked ? [] : cloudflareCredentials.filter(name => !env[name]?.trim());
 return [
  ...(credentials.length ? [`${credentials.join(' and ')} (${credentialHelp(declaration).join(' ')})`] : []),
  ...secrets,
  ...(mail ? [`production sign-in mail: ${mail}${deployGuide(declaration) ? ` (see ${deployGuide(declaration)})` : ''}`] : []),
 ];
}

export function reportNeeded(store, needed) {
 if (!needed.length) return;
 store.report('Needed for a real deploy (this dry run went ahead without them):');
 for (const item of needed) store.report(`  - ${item}`);
}
