import { Api } from './api.mjs';
import { mcpClient, ownerLink } from './questions.mjs';
import { paired } from './local-commands.mjs';
import { describe } from './errors.mjs';
import { businessCommand } from './invocation.mjs';
import { rows } from './agent-table.mjs';
import { parseArguments, place, missing, Usage } from './agent-args.mjs';
import { plain, refusalText, clean } from './agent-output.mjs';
import { waitFor, failedState, stateName, exitStillWaiting } from './agent-wait.mjs';
import { agentUsage } from './agent-help.mjs';
import { maskDeviceText } from './run-mask.mjs';
import { refusalView, refusalData, toolRefusal, serverSaid } from './refusal.mjs';

export const exitNotBuilt = 3;

class Refused extends Error {
 constructor(data) { super(data?.message ?? 'Business refused the action.'); this.data = data; }
}

// A tool's structuredContent, or the refusal it came back with.
async function invoke(session, tool, args) {
 const result = await session.call(tool, args);
 if (result?.isError) throw new Refused(toolRefusal(result));
 if (!result?.structuredContent || typeof result.structuredContent !== 'object') throw Error(`Business returned no result for ${tool}.`);
 return result.structuredContent;
}

const idOf = (data, key) => data[key]?.id ?? data[`${key}_id`];

function failed(data, subject) {
 const safe = refusalData({ ...data, data: data.change ?? data.update, status: stateName(data) });
 return Object.assign(Error(`The ${subject} ${clean(stateName(data), 60)}.${serverSaid(safe.message)}`), { exitCode: 1, data: safe });
}

async function change(row, args, control, session, say) {
 let data = await invoke(session, row.tool, args);
 const id = idOf(data, 'change') ?? args.change_id;
 if (typeof id === 'string') say(`Change ${clean(id, 80)}: ${clean(stateName(data) ?? 'requested', 60)}`);
 if (!control.wait && !control.publish) {
  if (row.tool === 'change.request' && typeof id === 'string') say(`Follow it with: ${businessCommand(`change follow ${id} --wait`)}`);
  return data;
 }
 if (typeof id !== 'string') throw Error('Business did not name the change, so there is nothing to follow.');
 const options = { say: state => say(`Change ${id}: ${state}`), timeout: control.timeout, interval: control.interval, from: stateName(data) };
 const follow = () => invoke(session, 'change.follow', { change_id: id });
 let waited = await waitFor(follow, options);
 if (waited.ended && control.publish && !failedState(waited.data) && waited.data.next === 'publish') {
  const published = await invoke(session, 'change.publish', { change_id: id });
  say(`Change ${id}: ${stateName(published) ?? 'publishing'}`);
  waited = await waitFor(follow, { ...options, publishing: true, from: stateName(published) ?? 'publishing' });
 }
 data = waited.data;
 if (!waited.ended) throw Object.assign(Error(`Still working after ${control.timeout ?? 1800} seconds. Keep waiting with: ${businessCommand(`change follow ${id} --wait`)}`), { exitCode: exitStillWaiting, data });
 if (failedState(data)) throw failed(data, 'change');
 if (data.next === 'ask_owner') say('The owner needs to answer something in Business before this can go on.');
 else if (data.next === 'publish') say(`Its preview is ready. Publish it with: ${businessCommand(`change publish ${id}`)}`);
 return data;
}

async function update(row, args, control, session, say) {
 const data = await invoke(session, row.tool, args);
 if (!control.wait) return data;
 const waited = await waitFor(() => invoke(session, 'update.follow', args), { say: state => say(`Update ${args.installation_id}: ${state}`), timeout: control.timeout, interval: control.interval });
 if (!waited.ended) throw Object.assign(Error(`Still working after ${control.timeout ?? 1800} seconds. Keep waiting with: ${businessCommand(`update follow ${args.installation_id} --wait`)}`), { exitCode: exitStillWaiting, data: waited.data });
 if (failedState(waited.data)) throw failed(waited.data, 'update');
 return waited.data;
}
const waiters = { change, update };

async function work(row, parsed, session, out) {
 const args = place(row, parsed), absent = missing(row, args), { control } = parsed;
 if (absent.length) throw new Usage(`${row.tool} needs ${absent.map(name => `--${name.replaceAll('_', '-')}`).join(', ')}. Run ~/.local/bin/rer business ${row.name.split(' ')[0]} --help.`);
 for (const flag of ['wait', 'publish']) {
  if (control[flag] && !(row.wait && (flag === 'wait' || row.tool.startsWith('change.')))) throw new Usage(`${row.name} does not take --${flag}.`);
 }
 const say = line => out.line(line);
 out.result(row.tool, row.wait ? await waiters[row.wait](row, args, control, session, say) : await invoke(session, row.tool, args));
}

// Lines for a person go to stdout; with --json only the final structuredContent does, and progress goes to stderr.
function output(json) {
 return {
  line: text => (json ? process.stderr : process.stdout).write(maskDeviceText(text) + '\n'),
  result: (tool, data) => { if (json) process.stdout.write(maskDeviceText(JSON.stringify(data)) + '\n'); else for (const line of plain(tool, data)) process.stdout.write(line + '\n'); },
 };
}

async function listTools(session, json) {
 const tools = [];
 let cursor;
 for (let page = 0; page < 20; page++) {
  const response = await session.exchange('tools/list', cursor ? { cursor } : {});
  if (response.error) throw Error(`Business MCP refused tools/list.${serverSaid(refusalView(response.error).sentence)}`);
  tools.push(...(Array.isArray(response.result?.tools) ? response.result.tools : []));
  cursor = response.result?.nextCursor;
  if (!cursor) break;
 }
 if (json) process.stdout.write(maskDeviceText(JSON.stringify({ tools })) + '\n');
 else for (const tool of tools) process.stdout.write(`${clean(tool.name, 80)}  ${clean(String(tool.description ?? '').split('\n')[0], 160)}`.trimEnd() + '\n');
}

function usage(text) { process.stderr.write(`${text}\n${agentUsage}`); return 2; }

export async function agentCommand(argv) {
 const [first, second, ...rest] = argv;
 if (first === 'mcp') return (await import('./mcp-bridge.mjs')).bridge();
 let row, tail = rest;
 if (first === 'tools') { row = { name: 'tools' }; tail = [second, ...rest].filter(item => item !== undefined); }
 else if (first === 'call') {
  if (!/^[a-z][a-z0-9_.]{0,80}$/.test(second ?? '')) return usage('Name the tool: ~/.local/bin/rer business call TOOL [--flag VALUE].');
  row = { name: `call ${second}`, tool: second };
 } else {
  row = rows[`${first} ${second}`] && { name: `${first} ${second}`, ...rows[`${first} ${second}`] };
  if (!row) return usage(`Unknown command: ~/.local/bin/rer business ${first}${second ? ` ${clean(second, 40)}` : ''}.`);
 }
 let parsed;
 try { parsed = await parseArguments(tail); } catch (error) { if (error instanceof Usage) return usage(error.message); throw error; }
 const out = output(parsed.control.json);
 let state;
 try {
  const connection = await paired();
  state = connection.state;
  const session = await mcpClient(new Api(state.origin, connection.credential));
  if (row.name === 'tools') await listTools(session, parsed.control.json);
  else await work(row, parsed, session, out);
  return 0;
 } catch (error) {
  if (error instanceof Usage) return usage(error.message);
  if (error instanceof Refused) {
   const text = refusalText(error.data, ownerLink(state));
   if (parsed.control.json) process.stdout.write(maskDeviceText(JSON.stringify(error.data ?? {})) + '\n');
   process.stderr.write(text + '\n');
   return error.data?.status === 'not_built' ? exitNotBuilt : 1;
  }
  if (error.data && parsed.control.json) process.stdout.write(maskDeviceText(JSON.stringify(error.data)) + '\n');
  process.stderr.write(describe(error) + '\n');
  return error.exitCode ?? 1;
 }
}
