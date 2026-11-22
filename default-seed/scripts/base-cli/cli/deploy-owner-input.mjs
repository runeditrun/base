import { createInterface } from 'node:readline/promises';
import { invalid, missing } from './errors.mjs';
import { validOwnerName } from './parse.mjs';
import { normalizeEmail } from '../modules/operator-auth/policy.mjs';
import { savedSetupAnswers, rememberSetupAnswers } from './setup-answers.mjs';
import { shared } from './shared.mjs';
import { heldDeployments } from './deployment-record.mjs';

// Resolve the installer identity before building or uploading. Names are safe
// installer answers, not runtime secrets, and use the same custody as setup.
export async function deployOwnerInput({ root, adapter, setupSeed, options, signal, declaration, env = process.env }) {
 const key = adapter.input?.names?.name ?? 'displayName';
 const field = setupSeed?.model.fields[key];
 if (!field || field.type === 'password') {
  if (options.ownerName !== undefined) throw invalid('This installer does not declare an owner-name field; --owner-name is unsupported.');
  return { input: {} };
 }
 const project = { root, adapter, setupSeed };
 const input = await savedSetupAnswers(project, setupSeed.model) ?? {};
 const given = env[key]?.trim() ? env[key] : undefined;
 let displayName = options.ownerName ?? given ?? input[key];
 let remember = options.ownerName !== undefined || given === undefined;
 if (!displayName?.trim() && adapter.hooks?.secrets) {
  const { readSettings } = await shared('adapter-settings.mjs');
  displayName = (await readSettings(root, adapter.hooks.secrets)).values[key];
 }
 if (!displayName?.trim()) {
  // A recorded bootstrap keeps its owner; resolving inputs needs no provider read.
  const held = (await heldDeployments(root)).find(item => item.environment === (options.environment ?? 'production'));
  if (['claimed', 'kept'].includes(held?.record.ownerClaim?.outcome)) return { input };
  const defaults = await adapter.input?.defaults?.(root);
  displayName = [defaults?.[key], field.default].find(value => typeof value === 'string' && value.trim());
  if (displayName !== undefined || field.optional) {
   remember = false;
   displayName ??= emailName(setupSeed.manifest, declaration, env);
   if (displayName === undefined) return { input };
  } else {
   if (options.dryRun) return { input, neededForRealDeploy: ['owner name (--owner-name or ~/.local/bin/rer setup)'] };
   displayName = await promptForName(options, signal);
  }
 }
 if (!validOwnerName(displayName)) throw invalid('Provide a valid owner name.');
 input[key] = displayName;
 if (!options.dryRun && remember) await rememberSetupAnswers(project, input);
 return { input, displayName: displayName.trim() };
}

function emailName(manifest, declaration, env) {
 const emailField = manifest?.steps.find(step => step.type === 'owner-claim')?.emailField;
 if (!emailField) return;
 const key = declaration?.secrets?.find(item => item.binding === emailField)?.environment ?? emailField;
 try {
  const name = normalizeEmail(env[key]).split('@')[0];
  if (validOwnerName(name)) return name;
 } catch { /* Deploy handles missing or invalid owner email separately. */ }
}

async function promptForName(options, signal) {
 const advice = 'Deploy needs your owner name; run ~/.local/bin/rer deploy --owner-name "Your name" (or ~/.local/bin/rer setup --owner-name "Your name"). Nothing was uploaded.';
 if (options.nonInteractive || options.json || !process.stdin.isTTY) throw missing(advice);
 const prompt = createInterface({ input: process.stdin, output: process.stderr });
 const closed = new Promise((_, reject) => prompt.once('close', () => reject(missing(advice))));
 try { return await Promise.race([prompt.question('Your name (hosted owner): ', { signal }), closed]); }
 finally { prompt.close(); }
}
