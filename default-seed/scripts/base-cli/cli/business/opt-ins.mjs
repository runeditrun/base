import { basename } from 'node:path';
import { installService } from './service.mjs';
import { installPermissions } from './permissions.mjs';
import { saveState } from './state.mjs';
import { carryLive } from './carry.mjs';
import { rerCommand } from './invocation.mjs';

// The server's field names stay internal; people see the browser's sentences.
export const optIns = {
 installPermissions: 'Add rules so Claude Code never reads your secret files',
 awakeConsent: 'Keep this computer awake while it works',
 installService: 'Install the background service',
};
const optInNames = Object.keys(optIns);

export async function applyOptIns(api, state, { report = true } = {}) {
 let self;
 // A server without this route answers a device credential with 403 (or 404):
 // nothing is decided yet. This first authenticated request activates the computer.
 try { self = await api.get('/api/business/executors/self'); }
 catch (error) { if (![403, 404].includes(error.status)) throw error; }
 const carried = await carryLive(state, self);
 const decisions = Object.fromEntries(optInNames.map(name => [name, self?.optIns?.[name] === true ? true : self?.optIns?.[name] === false ? false : null]));
 if (decisions.installPermissions === true) await installPermissions({ consent: true });
 state.awakeConsent = decisions.awakeConsent === true;
 await saveState(state);
 if (decisions.installService === true) await installService({ consent: true });
 if (!report) return;
 process.stdout.write(`This computer is connected to Business at ${state.origin}.\n`);
 if (decisions.installService === true) {
  process.stdout.write('The background service is installed and works tasks after this chat ends.\n');
 }
 const undecided = optInNames.filter(name => decisions[name] === null);
 if (undecided.length) {
  process.stdout.write(`The owner has not chosen yet:\n${undecided.map(name => `  - ${optIns[name]}\n`).join('')}Ask them to choose on this computer's row in ${state.origin}/business/${encodeURIComponent(state.businessId)}/settings.\n`);
 }
 process.stdout.write(`After choosing this computer's apps or settings in Business, run ${rerCommand()} business next to apply them and see the next task.\n`);
 if (carried) process.stdout.write(carried.checkouts.length
  ? `Apps on this computer now show ${JSON.stringify(carried.name)}: ${carried.checkouts.map(checkout => JSON.stringify(basename(checkout))).join(', ')}.\n`
  : `No apps on this computer were updated to show ${JSON.stringify(carried.name)}.\n`);
}
