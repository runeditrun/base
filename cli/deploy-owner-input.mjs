import { createInterface } from 'node:readline/promises';
import { invalid, missing } from './errors.mjs';
import { validOwnerName } from './parse.mjs';
import { savedSetupAnswers, rememberSetupAnswers } from './setup-answers.mjs';
import { shared } from './shared.mjs';

// Resolve the installer identity before building or uploading. Names are safe
// installer answers, not runtime secrets, and use the same custody as setup.
export async function deployOwnerInput({ root, adapter, setupSeed, options, signal }) {
 const key = adapter.input?.names?.name ?? 'displayName';
 if (!setupSeed?.model.fields[key]) {
  if (options.ownerName !== undefined) throw invalid('This installer does not declare an owner-name field; --owner-name is unsupported.');
  return { input: {} };
 }
 const project = { root, adapter, setupSeed };
 const input = await savedSetupAnswers(project, setupSeed.model) ?? {};
 let displayName = options.ownerName ?? input[key];
 if (displayName === undefined && adapter.hooks?.secrets) {
  const { readSettings } = await shared('adapter-settings.mjs');
  displayName = (await readSettings(root, adapter.hooks.secrets)).values[key];
 }
 const advice = 'Deploy needs your owner name; run rer deploy --owner-name "Your name" (or rer setup --owner-name "Your name"). Nothing was uploaded.';
 if (!displayName?.trim()) {
  if (options.dryRun) return { input };
  if (options.nonInteractive || options.json || !process.stdin.isTTY) throw missing(advice);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new Promise((_, reject) => prompt.once('close', () => reject(missing(advice))));
  try { displayName = await Promise.race([prompt.question('Your name (hosted owner): ', { signal }), closed]); }
  finally { prompt.close(); }
 }
 if (!validOwnerName(displayName)) throw invalid('Provide a valid owner name.');
 input[key] = displayName;
 if (!options.dryRun) await rememberSetupAnswers(project, input);
 return { input, displayName };
}
