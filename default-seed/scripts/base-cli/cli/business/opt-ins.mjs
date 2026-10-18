import { installService } from './service.mjs';
import { installPermissions } from './permissions.mjs';
import { saveState } from './state.mjs';
import { rerCommand } from './invocation.mjs';

// The server's field names stay internal; people see the browser's sentences.
export const optIns = {
 installPermissions: 'Add rules so Claude Code never reads your secret files',
 awakeConsent: 'Keep this computer awake while it works',
 installService: 'Install the background service',
};
const optInNames = Object.keys(optIns);

export async function applyOptIns(api, state) {
 let self;
 // A server without this route answers a device credential with 403 (or 404):
 // nothing is decided yet. This first authenticated request activates the computer.
 try { self = await api.get('/api/business/executors/self'); }
 catch (error) { if (![403, 404].includes(error.status)) throw error; }
 const decisions = Object.fromEntries(optInNames.map(name => [name, self?.optIns?.[name] === true ? true : self?.optIns?.[name] === false ? false : null]));
 if (decisions.installPermissions === true) await installPermissions({ consent: true });
 state.awakeConsent = decisions.awakeConsent === true;
 await saveState(state);
 process.stdout.write(`This computer is connected to Business at ${state.origin}.\n`);
 if (decisions.installService === true) {
  await installService({ consent: true });
  process.stdout.write('The background service is installed and works tasks after this chat ends.\n');
 } else process.stdout.write(`Run ${rerCommand()} business run to work tasks.\n`);
 const undecided = optInNames.filter(name => decisions[name] === null);
 if (undecided.length) {
  process.stdout.write(`The owner has not chosen yet:\n${undecided.map(name => `  - ${optIns[name]}\n`).join('')}Ask them to choose on this computer's row in ${state.origin}/business/${encodeURIComponent(state.businessId)}/settings, then run ${rerCommand()} business connect again to apply the choices.\n`);
 }
}
