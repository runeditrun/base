import { installService, removeService } from './service.mjs';
import { installPermissions, removePermissions } from './permissions.mjs';
import { saveState } from './state.mjs';
import { businessCommand } from './invocation.mjs';
import { describe } from './errors.mjs';

// The owner's choices for this computer, as the browser words them. The
// server's field names stay internal.
export const choices = {
 installPermissions: 'Add rules so Claude Code never reads your secret files',
 awakeConsent: 'Keep this computer awake while it works',
 installService: 'Install the background service',
};
const names = Object.keys(choices);

const effects = {
 installPermissions: { true: () => installPermissions({ consent: true }), false: () => removePermissions() },
 awakeConsent: { true: async () => {}, false: async () => {} },
 installService: { true: () => installService({ consent: true }), false: () => removeService() },
};
const said = {
 installPermissions: { true: 'allowed; the rules are in Claude Code settings', false: 'not allowed; no rules added' },
 awakeConsent: { true: 'allowed while an export runs', false: 'not allowed' },
 installService: { true: 'allowed; the service is installed and works tasks after this chat ends', false: 'not allowed; no service installed' },
};

// What this process already told the person, so a long-running supervisor
// reports each refusal or open question once rather than on every check-in.
const reported = new Set();
const once = (key, text) => { if (reported.has(key)) return; reported.add(key); process.stdout.write(text); };

/** Read the owner's choices (GET /executors/self) and apply each one that
 * changed since this computer last applied it, then say which were applied.
 * connect, run and next all call this, so connect never has to run again.
 * A choice that cannot be applied here (an agent sandbox that cannot write
 * outside its folder) is named with its cause and tried again next check-in.
 */
export async function applyChoices(api, state) {
 let self;
 // A server without this route answers a device credential with 403 (or 404):
 // nothing is decided yet. On a new computer this first request activates it.
 try { self = await api.get('/api/business/executors/self'); }
 catch (error) { if (![403, 404].includes(error.status)) throw error; }
 const decided = Object.fromEntries(names.map(name => [name, typeof self?.optIns?.[name] === 'boolean' ? self.optIns[name] : null]));
 const applied = state.applied ?? {}, lines = [], refused = [];
 let serviceInstalled = false;
 for (const name of names) {
  const choice = decided[name];
  if (choice === null || applied[name] === choice) continue;
  try {
   await effects[name][choice]();
   applied[name] = choice;
   if (name === 'installService' && choice) serviceInstalled = true;
   lines.push(`  - ${choices[name]}: ${said[name][choice]}\n`);
  } catch (error) { refused.push({ name, error }); }
 }
 state.applied = applied;
 state.awakeConsent = applied.awakeConsent === true;
 if (lines.length) {
  await saveState(state);
  process.stdout.write(`Applied the owner's choices for this computer:\n${lines.join('')}`);
 }
 for (const { name, error } of refused) {
  once(`refused:${name}:${error.message}`, `Not applied yet: ${choices[name]}. ${describe(error)} The run and next commands try again at each check-in; to apply it now, run ${businessCommand('next')} outside the agent sandbox or in your own terminal.\n`);
 }
 const undecided = names.filter(name => decided[name] === null);
 if (undecided.length) {
  once(`undecided:${undecided.join()}`, `The owner has not chosen yet:\n${undecided.map(name => `  - ${choices[name]}\n`).join('')}They choose on this computer's row in ${state.origin}/business/${encodeURIComponent(state.businessId)}/settings; the run and next commands apply the choices at their next check-in, so connect does not need to run again.\n`);
 }
 return { applied: lines.length, serviceInstalled };
}
