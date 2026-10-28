import { installService, removeService } from './service.mjs';
import { installPermissions, removePermissions } from './permissions.mjs';
import { saveState } from './state.mjs';
import { carryLive } from './carry.mjs';
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

// Choices with no way to take effect for the agent on this computer. The rules
// are Claude Code's own settings, so they apply only when the computer's agent
// is Claude Code. For Codex, which has no equivalent Business can write yet, and
// for any other agent, nothing is written under ~/.claude and nothing asks for a
// run outside the sandbox. It is recorded and said once.
const notApplicable = {
 installPermissions: {
  codex: 'Secret-file rules do not apply on Codex: Business has no way yet to stop Codex from reading your secret files, so it added no rules and needs nothing more for this choice.\n',
  other: 'Secret-file rules do not apply on this computer: Business writes them only for Claude Code, and this computer\'s agent is not Claude Code, so it added no rules and needs nothing more for this choice.\n',
 },
};

/** Read the owner's choices (GET /executors/self) and apply each one that
 * changed since this computer last applied it, then say which were applied.
 * connect, run and next all call this, so connect never has to run again.
 * A choice that cannot be applied here (an agent sandbox that cannot write
 * outside its folder) is named with its cause and tried again next check-in.
 */
export async function applyChoices(api, state, { reconnecting = false } = {}) {
 let self;
 // A server without this route answers a device credential with 403 (or 404):
 // nothing is decided yet. On a new computer this first request activates it.
 try { self = await api.get('/api/business/executors/self'); }
 catch (error) { if (![403, 404].includes(error.status)) throw error; }
 await carryLive(state, self);
 const decided = Object.fromEntries(names.map(name => [name, typeof self?.optIns?.[name] === 'boolean' ? self.optIns[name] : null]));
 // The agent this computer reported when it paired, as the owner's browser words its choices:
 // the Claude Code rules apply only to Claude Code. An unknown agent (no route yet) decides nothing.
 const agent = self?.device?.agent_kind?.value;
 const inapplicable = Object.fromEntries(Object.entries(notApplicable).filter(() => agent && agent !== 'claude').map(([name, text]) => [name, text[agent] ?? text.other]));
 const applied = state.applied ?? {}, lines = [], refused = [], unavailable = [];
 let serviceInstalled = false;
 for (const name of names) {
  if (inapplicable[name]) {
   if (applied[name] !== 'not-applicable') { applied[name] = 'not-applicable'; unavailable.push(inapplicable[name]); }
   continue;
  }
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
 if (lines.length || unavailable.length) await saveState(state);
 if (lines.length) process.stdout.write(`Applied the owner's choices for this computer:\n${lines.join('')}`);
 for (const text of unavailable) process.stdout.write(text);
 for (const { name, error } of refused) {
  once(`refused:${name}:${error.message}`, `Not applied yet: ${choices[name]}. ${describe(error)} The run and next commands try again at each check-in; to apply it now, run ${businessCommand('next')} outside the agent sandbox or in your own terminal.\n`);
 }
 const undecided = names.filter(name => decided[name] === null && !inapplicable[name]);
 if (undecided.length) {
  once(`undecided:${undecided.join()}`, `The owner has not chosen yet:\n${undecided.map(name => `  - ${choices[name]}\n`).join('')}They choose on this computer's row in ${state.origin}/business/${encodeURIComponent(state.businessId)}/settings; the run and next commands apply the choices at their next check-in, ${reconnecting ? 'without pairing again' : 'so connect does not need to run again'}.\n`);
 }
 return { applied: lines.length, serviceInstalled };
}
