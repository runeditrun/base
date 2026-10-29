import { relative } from 'node:path';
import { isolatedNetworkAdapter } from '../modules/agent-door/conformance/network-runtime.mjs';
import { networkAdapterModules } from '../modules/agent-door/conformance/network-modules.mjs';
import { RerError } from './errors.mjs';
import { refuseHistoryImports } from './agent-history-isolation.mjs';

export const historyInvalid = () => new RerError('agent_history_invalid', 'agent_history_invalid: Verification history requires contained test-only modules and named, insert-only statements on declared disposable tables without triggers. No fixture values or SQL are logged.', 1);
const declarations = new WeakSet();
export const isHistoryDeclaration = value => declarations.has(value);
const identifier = '[A-Za-z_][A-Za-z0-9_]*';
// A deliberately small SQL language: no SELECT, expressions, conflict updates,
// schema qualifiers, comments, pragmas or multiple statements. Literals let a
// shared native records table constrain each statement to one history kind.
const insert = new RegExp(`^INSERT INTO (${identifier})\\s*\\((${identifier}(?:\\s*,\\s*${identifier})*)\\)\\s*VALUES\\s*\\((\\?|[0-9]+|'[A-Za-z0-9_-]*')(?:\\s*,\\s*(\\?|[0-9]+|'[A-Za-z0-9_-]*'))*\\)$`, 'i');

export async function historyDeclaration(root, config) {
 if (config === undefined) return;
 try {
  if (!config || Object.keys(config).sort().join(',') !== 'module,statements,steps'
   || typeof config.module !== 'string' || !config.module.startsWith('tests/')
   || !Array.isArray(config.steps) || !config.steps.length || config.steps.some(step => typeof step !== 'string' || !step)
   || !config.statements || Array.isArray(config.statements) || typeof config.statements !== 'object' || !Object.keys(config.statements).length) throw historyInvalid();
  const statements = new Map();
  for (const [name, value] of Object.entries(config.statements)) {
   if (!value || Object.keys(value).sort().join(',') !== 'binding,sql' || typeof value.binding !== 'string' || typeof value.sql !== 'string') throw historyInvalid();
   const match = insert.exec(value.sql);
   if (!match || /^(?:agent_door_|sqlite_|oa_)/i.test(match[1])) throw historyInvalid();
   statements.set(name, { ...value, table: match[1], parameters: (value.sql.match(/\?/g) ?? []).length });
  }
  const source = await networkAdapterModules(root, config.module);
  if (!relative(source.root, source.modules[0].path).startsWith('tests/')) throw historyInvalid();
  await refuseHistoryImports(root, source);
  const declaration = { module: config.module, steps: new Set(config.steps), statements };
  declarations.add(declaration);
  return declaration;
 } catch { throw historyInvalid(); }
}

/** Only checkAgentDoor starts this isolated test Worker. No application binding,
 * request credentials, Node API, filesystem or external network is supplied. */
export async function verificationHistory(root, config) {
 const declaration = await historyDeclaration(root, config);
 if (!declaration) return;
 const adapter = await isolatedNetworkAdapter(root, declaration.module, () => new Response(null, { status: 502 }));
 return { declaration, close: () => adapter.close(), run: async (context, write) => {
  if (context.stage !== 'beforeStep' || !['autonomous', 'held'].includes(context.phase) || !declaration.steps.has(context.step.id)) return;
  try {
   const { phase, step, args, outputs, now } = context;
   const response = await adapter.fetch(new Request('https://history.invalid/', { method: 'POST', body: JSON.stringify({ phase, step, args, outputs, now }) }));
   const body = await response.text();
   if (!response.ok || body.length > 2 * 1024 * 1024) throw historyInvalid();
   await write(declaration, JSON.parse(body));
  } catch { throw historyInvalid(); }
 } };
}
