import { installService } from './service.mjs';
import { installPermissions } from './permissions.mjs';
import { saveState } from './state.mjs';
import { rerCommand } from './invocation.mjs';

export const optInNames = ['installPermissions', 'awakeConsent', 'installService'];

export async function applyOptIns(api, state) {
 let self;
 // A server without this route answers a device credential with 403 (or 404):
 // nothing is decided yet.
 try { self = await api.get('/api/business/executors/self'); }
 catch (error) { if (![403, 404].includes(error.status)) throw error; }
 const decisions = Object.fromEntries(optInNames.map(name => [name, self?.optIns?.[name] === true ? true : self?.optIns?.[name] === false ? false : null]));
 if (decisions.installPermissions === true) await installPermissions({ consent: true });
 state.awakeConsent = decisions.awakeConsent === true;
 await saveState(state);
 if (decisions.installService === true) {
  await installService({ consent: true });
  process.stdout.write('Business background service installed.\n');
 } else process.stdout.write(`Run ${rerCommand()} business run to work tasks.\n`);
 const undecided = optInNames.filter(name => decisions[name] === null);
 if (undecided.length) process.stdout.write(`Ask the owner to decide ${undecided.join(', ')} in ${state.origin}/business/${encodeURIComponent(state.businessId)}/settings, then run ${rerCommand()} business connect again.\n`);
}
