import { redact } from './errors.mjs';
import { refusalData, serverSaid } from './refusal.mjs';

const refusalHandled = new Set(['status', 'code', 'action', 'message']);
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
export const clean = (value, limit = 300) => redact(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim().slice(0, limit);

// One plain line for an object: its scalar fields as key=value, nested values as compact JSON.
function item(object) {
 if (scalar(object)) return clean(object);
 return Object.entries(object).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}=${clean(value, 120)}`).join('  ');
}

/** A tool result as a few plain lines. */
export function plain(tool, data) {
 if (tool === 'installations.list' && Array.isArray(data.installations)) {
  if (!data.installations.length) return ['No apps are installed for this company yet.'];
  return data.installations.map(app => [app.installation_id, app.app, app.name, app.state, app.version, app.app_url].filter(part => part !== undefined && part !== null).map(part => clean(part, 120)).join('  '));
 }
 const lines = [];
 for (const [key, value] of Object.entries(data)) {
  if (value === null || value === undefined) continue;
  if (Array.isArray(value)) { lines.push(`${key}: ${value.length ? '' : 'none'}`.trimEnd(), ...value.map(entry => `  - ${item(entry)}`)); }
  else if (scalar(value)) lines.push(`${key}: ${clean(value)}`);
  else lines.push(`${key}: ${item(value)}`);
 }
 return lines.length ? lines : ['Done.'];
}

/** Why a tool refused, in words the person reading an agent's transcript can act on. */
export function refusalText(data, ownerPage) {
 data = refusalData(data);
 const message = data.message || null;
 if (data?.status === 'not_built') return `Not built yet: ${message ?? 'Business has not built this yet.'}`;
 if (data?.status === 'action_not_granted') {
  const action = typeof data.action === 'string' ? clean(data.action, 80) : 'this action';
  return `The owner has not let this computer do "${action}". The owner grants it in Business, under Computers: ${ownerPage}${serverSaid(message)}`;
 }
 const code = typeof data?.code === 'string' ? ` (${clean(data.code, 80)})` : '';
 const extra = Object.entries(data).filter(([key]) => !refusalHandled.has(key)).map(([key, value]) => `\n${key}: ${clean(value, 500)}`).join('');
 return `Business refused: ${message ?? data?.status ?? 'no reason given'}${code}${extra}`;
}
