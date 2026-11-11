import { count, integer, isInt, isObject, keyed, methods, name as personaName, slug, stringsIn, templateRefs, variable } from './validate-kit.mjs';

const pointer = /^(?:\/(?:[^~/]|~[01])*)+$/;

// Template problems in `texts`. `own` is the variable set a {{var}} may use (inside a persona); without it only
// {{persona.var}} is allowed (inside a flow) and `personas` maps each persona to its captured variables.
function templates(found, texts, path, { own, personas }) {
 for (const text of texts) for (const ref of templateRefs(text)) {
  if (ref.bad) found.add(path, `${ref.bad} is not a template; write {{var}} inside a persona or {{persona.var}} inside a flow.`);
  else if (own) {
   if (ref.persona) found.add(path, `{{${ref.persona}.${ref.variable}}} names a persona inside a persona's own requests; write {{${ref.variable}}}.`);
   else if (!own.has(ref.variable)) found.add(path, `{{${ref.variable}}} is not captured by an earlier request of this persona; add capture ${ref.variable} to the request that returns it, or correct the name.`);
  } else if (!ref.persona) found.add(path, `{{${ref.variable}}} needs its persona in a flow; write {{persona.${ref.variable}}}.`);
  else if (!personas.has(ref.persona)) found.add(path, `{{${ref.persona}.${ref.variable}}}: persona ${ref.persona} is not declared in personas.`);
  else if (!personas.get(ref.persona).has(ref.variable)) found.add(path, `{{${ref.persona}.${ref.variable}}}: persona ${ref.persona} captures no ${ref.variable}; add capture ${ref.variable} to one of its requests, or correct the name.`);
 }
}

function headers(found, value, path, scope) {
 if (!isObject(value)) { found.add(path, 'must map header names to text, for example { "Authorization": "Bearer {{token}}" }.'); return; }
 for (const [header, text] of Object.entries(value)) {
  if (typeof text !== 'string') found.add([...path, header], 'must be text.');
  else templates(found, [text], [...path, header], scope);
 }
}

function request(found, value, path, scope, { setup }) {
 const allowed = setup ? ['method', 'path', 'body', 'headers', 'capture'] : ['method', 'path', 'body', 'headers', 'websocket'];
 if (!keyed(found, value, path, allowed, setup ? 'a setup request' : 'a request')) return;
 if (!methods.includes(value.method)) found.add([...path, 'method'], `must be one of ${methods.join(', ')}.`);
 if (typeof value.path !== 'string' || !value.path.startsWith('/')) found.add([...path, 'path'], 'must be a route path starting with "/".');
 else templates(found, [value.path], [...path, 'path'], scope);
 if (value.body !== undefined) templates(found, stringsIn(value.body), [...path, 'body'], scope);
 if (value.headers !== undefined) headers(found, value.headers, [...path, 'headers'], scope);
 if (!setup && value.websocket !== undefined && typeof value.websocket !== 'boolean') found.add([...path, 'websocket'], 'must be true or false.');
}

// personas: returns Map persona -> Set of captured variables. Each persona's own templates see earlier captures only.
export function validatePersonas(found, personas, path) {
 const captured = new Map();
 if (personas === undefined) return captured;
 if (!isObject(personas)) { found.add(path, 'must map a persona name to { "kind": "owner" | "anonymous" | "signin" }.'); return captured; }
 for (const [persona, spec] of Object.entries(personas)) {
  const here = [...path, persona], variables = new Set();
  captured.set(persona, variables);
  if (!personaName.test(persona)) found.add(here, 'is not a persona name (lowercase letters, digits and underscore, starting with a letter).');
  if (!isObject(spec) || !['owner', 'anonymous', 'signin'].includes(spec.kind)) { found.add([...here, 'kind'], 'must be "owner", "anonymous" or "signin".'); continue; }
  if (spec.kind !== 'signin') { keyed(found, spec, here, ['kind'], `a ${spec.kind} persona`); continue; }
  if (!keyed(found, spec, here, ['kind', 'requests', 'headers'], 'a signin persona')) continue;
  if (!Array.isArray(spec.requests) || spec.requests.length < 1 || spec.requests.length > 4) found.add([...here, 'requests'], 'must list 1 to 4 sign-in requests, run in order.');
  else spec.requests.forEach((item, index) => {
   request(found, item, [...here, 'requests', index], { own: new Set(variables) }, { setup: true });
   if (isObject(item) && item.capture !== undefined) {
    if (!isObject(item.capture) || !Object.keys(item.capture).length) found.add([...here, 'requests', index, 'capture'], 'must map a variable name to a JSON pointer into the response, for example { "token": "/token" }.');
    else for (const [key, at] of Object.entries(item.capture)) {
     if (!variable.test(key)) found.add([...here, 'requests', index, 'capture', key], 'is not a variable name.');
     else if (typeof at !== 'string' || !pointer.test(at)) found.add([...here, 'requests', index, 'capture', key], 'must be a JSON pointer such as "/token".');
     else variables.add(key);
    }
   }
  });
  if (spec.headers !== undefined) headers(found, spec.headers, [...here, 'headers'], { own: variables });
 }
 return captured;
}

function growth(found, value, path) {
 if (!keyed(found, value, path, ['allowed', 'why'], 'growth')) return;
 if (value.allowed !== true) found.add([...path, 'allowed'], 'must be true; delete growth to have the flow checked for growth.');
 if (typeof value.why !== 'string' || !value.why.trim()) found.add([...path, 'why'], 'growth.allowed needs a why: say in one sentence why this flow may read more at the large size; it is printed on every run.');
}

function status(found, value, path) {
 const codes = Array.isArray(value) ? value : [value];
 if (!codes.length || !codes.every(code => isInt(code, 100, 599))) found.add(path, 'must be an HTTP status from 100 to 599, or a non-empty list of them.');
}

// flows: returns the normalized list. `facts.crons` are the crons the checkout declares; `budget.windowRows` may be unset.
export function validateFlows(found, flows, path, { personas, crons, windowRows }) {
 if (!Array.isArray(flows) || flows.length < 1 || flows.length > 64) { found.add(path, 'must list 1 to 64 flows, each with a ceiling.'); return []; }
 const names = new Set(), normalized = [];
 flows.forEach((flow, index) => {
  const label = typeof flow?.name === 'string' && slug.test(flow.name) ? flow.name : index, here = [...path, label];
  const scheduled = isObject(flow) && flow.scheduled !== undefined;
  if (!keyed(found, flow, here, ['name', 'ceiling', 'callsInRow', 'repeat', 'status', 'growth', ...(scheduled ? ['scheduled'] : ['persona', 'request'])], 'a flow')) return;
  if (typeof flow.name !== 'string' || !slug.test(flow.name)) found.add([...here, 'name'], 'must be a short name of lowercase letters, digits and hyphens.');
  else if (names.has(flow.name)) found.add([...here, 'name'], `${flow.name} is used by two flows; give each flow its own name.`);
  else names.add(flow.name);
  if (scheduled) {
   if (typeof flow.scheduled !== 'string' || !flow.scheduled.trim()) found.add([...here, 'scheduled'], 'must be one of the cron expressions the build declares.');
   else if (!crons.includes(flow.scheduled)) found.add([...here, 'scheduled'], `cron "${flow.scheduled}" is not one the checkout declares (${crons.length ? crons.map(cron => `"${cron}"`).join(', ') : 'it declares none'}); name a declared cron, or declare it in triggers.crons.`);
  } else {
   if (typeof flow.persona !== 'string' || !personas.has(flow.persona)) found.add([...here, 'persona'], `${typeof flow.persona === 'string' ? `persona ${flow.persona} is not declared` : 'is required for a request flow'}; declare it under personas${personas.size ? ` (declared: ${[...personas.keys()].join(', ')})` : ''}, or correct the name.`);
   if (flow.request === undefined) found.add([...here, 'request'], 'is required; give method and path, or use "scheduled" for a cron flow.');
   else request(found, flow.request, [...here, 'request'], { personas }, { setup: false });
  }
  const ceiling = integer(found, flow.ceiling, [...here, 'ceiling'], 1, undefined, 'it is the rows this flow may read at the large size, per call');
  const calls = flow.callsInRow === undefined ? true : integer(found, flow.callsInRow, [...here, 'callsInRow'], 1);
  if (ceiling && calls && windowRows) {
   const inRow = flow.callsInRow ?? 1, total = flow.ceiling * inRow;
   if (total > windowRows) found.add([...here, 'ceiling'], `ceiling ${count(flow.ceiling)} x callsInRow ${count(inRow)} = ${count(total)} rows, over budget.windowRows ${count(windowRows)}; lower the ceiling or the calls in a row.`);
  }
  if (flow.repeat !== undefined && ![1, 2, 3].includes(flow.repeat)) found.add([...here, 'repeat'], 'must be 1, 2 or 3.');
  if (flow.status !== undefined) status(found, flow.status, [...here, 'status']);
  if (flow.growth !== undefined) growth(found, flow.growth, [...here, 'growth']);
  normalized.push({ ...flow, callsInRow: flow.callsInRow ?? 1, repeat: flow.repeat ?? 1, status: flow.status === undefined ? null : [].concat(flow.status), growth: flow.growth ?? null });
 });
 return normalized;
}
