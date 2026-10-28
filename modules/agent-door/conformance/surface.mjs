export const AGENT_CLASSES = Object.freeze(['standard', 'external', 'money', 'commitment', 'accounts', 'gated', 'access', 'security', 'destructive', 'sensitive', 'live']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasClause = (contract, clause) => typeof clause === 'string' && contract.split(/[^A-Za-z0-9_.-]+/).includes(clause);
const text = value => typeof value === 'string' && value.trim().length > 0;
// Argument names that can carry authority to add: a person, role, scope or grant.
const authorityWords = new Set(['person', 'people', 'user', 'users', 'member', 'members', 'email', 'operator', 'owner', 'admin', 'sponsor', 'invite', 'role', 'roles', 'scope', 'scopes', 'grant', 'grants', 'permission', 'permissions', 'privilege', 'privileges', 'capability', 'capabilities', 'access', 'delegate']);
const words = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Every property name a schema can carry, at any depth, other than the declared subject. */
function argumentNames(schema, subject, top = true) {
 if (!object(schema)) return [];
 const nested = [...['items', 'additionalProperties', 'not'].map(key => schema[key]), ...['anyOf', 'oneOf', 'allOf', 'prefixItems'].flatMap(key => Array.isArray(schema[key]) ? schema[key] : []), ...Object.values(object(schema.patternProperties) ? schema.patternProperties : {})];
 return [...Object.entries(object(schema.properties) ? schema.properties : {}).flatMap(([name, value]) => [...(top && name === subject ? [] : [name]), ...argumentNames(value, subject, false)]),
  ...(object(schema.patternProperties) || (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ? ['*'] : []), ...nested.flatMap(value => argumentNames(value, subject, false))];
}

/** Validate the edition's static declaration without loading application code. */
export function validateAgentSurface(surface, { contract } = {}) {
 const points = [], add = (id, ok, detail) => points.push({ id: `BASE-AGENT-013.surface.${id}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) });
 add('schema', object(surface) && surface.schema === 'rer-agent-surface/1', 'Agent surface must use schema rer-agent-surface/1.');
 if (!object(surface)) return { ok: false, points };
 add('seed', text(surface.seed) && /^[a-z][a-z0-9-]*$/.test(surface.seed), `Invalid seed ${JSON.stringify(surface.seed)}.`);
 add('specialist', text(surface.specialist), 'Agent surface must name its specialist.');
 add('tools', Array.isArray(surface.tools) && surface.tools.length > 0, 'Agent surface must declare its tools.');
 add('notTools', Array.isArray(surface.notTools), 'Agent surface must declare notTools.');
 add('resources', Array.isArray(surface.resources), 'Agent surface must declare resources.');
 for (const uri of Array.isArray(surface.resources) ? surface.resources : []) add(`resource.${String(uri)}`, text(uri), 'Resource template must be a URI string.');
 add('journey', Array.isArray(surface.journey) && surface.journey.length > 0, 'Agent surface must declare its journey.');
 const escalation = (id, ok, detail) => points.push({ id: `BASE-AGENT-005.surface.${id}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) });
 escalation('escalations', surface.escalations === undefined || Array.isArray(surface.escalations), 'Agent surface must declare its escalations.');
 const tools = new Map(), steps = new Set(), coverage = new Map();
 for (const [i, tool] of (Array.isArray(surface.tools) ? surface.tools : []).entries()) {
  const name = tool?.name, label = text(name) ? name : `tools[${i}]`;
  add(`${label}.name`, text(name) && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(name) && name.split('.')[0] === surface.seed && !tools.has(name), `Malformed, duplicate or foreign-seed tool ${JSON.stringify(name)}.`);
  add(`${label}.scope`, text(tool?.scope), `${label} must declare its scope.`);
  add(`${label}.readOnly`, typeof tool?.readOnly === 'boolean', `${label} must declare readOnly.`);
  add(`${label}.classes`, Array.isArray(tool?.classes) && tool.classes.length > 0 && new Set(tool.classes).size === tool.classes.length && tool.classes.every(cls => AGENT_CLASSES.includes(cls)), `${label} has an empty, duplicate or uncatalogued class: ${JSON.stringify(tool?.classes)}.`);
  const clauses = Array.isArray(tool?.clauses) ? tool.clauses : [];
  add(`${label}.clauses`, clauses.length > 0 && clauses.every(text), `${label} must name its contract clauses.`);
  if (contract !== undefined) for (const clause of clauses) add(`${label}.clause.${clause}`, hasClause(contract, clause), `${label} names clause ${clause}, absent from CONTRACT.md.`);
  if (tool?.widens !== undefined) {
   const widening = argumentNames(tool.inputSchema, tool.subject).filter(name => name === '*' || words(name).some(word => authorityWords.has(word)));
   escalation(`${label}.narrowing`, tool.widens === false && Array.isArray(tool.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls)) && ['revoke', 'narrow'].includes(tool.effect)
    && object(tool.inputSchema) && tool.inputSchema.type === 'object' && text(tool.subject) && tool.inputSchema.properties?.[tool.subject]?.type === 'string'
    && tool.inputSchema.properties[tool.subject].enum === undefined && tool.inputSchema.properties[tool.subject].const === undefined && !widening.length,
   `${label} declares widens:false; it needs an access or security class, effect revoke or narrow, and a closed inputSchema whose only authority-bearing argument is its string identifier subject${widening.length ? ` (also ${widening.join(', ')})` : ''}.`);
  }
  if (tool?.proof !== undefined) add(`${label}.proof`, object(tool.proof) && Object.keys(tool.proof).join() === 'native' && /^[a-z][a-z0-9_]{0,63}$/.test(tool.proof.native ?? '') && text(surface.verification?.proof?.module), `${label} declares native proof as {native:'<kind>'} with verification.proof.module, the seed's test proof.`);
  tools.set(name, tool); coverage.set(name, new Set());
 }
 for (const [i, item] of (Array.isArray(surface.notTools) ? surface.notTools : []).entries()) {
  add(`notTools.${i}`, object(item) && ['device', 'screen', 'connector', 'import-door', 'installation'].includes(item.reason) && Array.isArray(item.clauses) && item.clauses.length > 0 && item.clauses.every(text), `notTools[${i}] must name clauses and a concrete reason other than risk.`);
  if (contract !== undefined && Array.isArray(item?.clauses)) for (const clause of item.clauses) add(`notTools.${i}.${clause}`, hasClause(contract, clause), `notTools[${i}] names clause ${clause}, absent from CONTRACT.md.`);
 }
 const references = (value, visit) => {
  if (Array.isArray(value)) value.forEach(item => references(item, visit));
  else if (object(value)) { if ('$from' in value || '$sponsor' in value) visit(value); else Object.values(value).forEach(item => references(item, visit)); }
 };
 const checkReferences = (value, label, available, addPoint = add) => references(value, ref => {
  if ('$sponsor' in ref) addPoint(`${label}.sponsor`, Object.keys(ref).length === 1 && ['id', 'email'].includes(ref.$sponsor), `${label} must reference the sponsor as {$sponsor:'id'} or {$sponsor:'email'}.`);
  else addPoint(`${label}.ref.${ref.$from}`, available.has(ref.$from) && typeof ref.pointer === 'string' && (ref.pointer === '' || ref.pointer.startsWith('/')), `${label} references ${ref.$from} before its structuredContent is available, or has an invalid JSON pointer.`);
 });
 for (const [i, step] of (Array.isArray(surface.journey) ? surface.journey : []).entries()) {
  const id = text(step?.id) ? step.id : `journey[${i}]`, tool = tools.get(step?.tool);
  add(`journey.${id}`, object(step) && text(step.id) && !steps.has(step.id) && Boolean(tool) && object(step.args) && Array.isArray(step.expect) && step.expect.length > 0 && tool.proof === undefined, `Invalid or duplicate journey step ${id}, tool ${JSON.stringify(step?.tool)}; a native-proof tool belongs in proofs.`);
  const expect = Array.isArray(step?.expect) ? step.expect : [];
  add(`journey.${id}.classes`, new Set(expect.map(item => item?.class)).size === expect.length && expect.every(item => object(item) && Array.isArray(tool?.classes) && tool.classes.includes(item.class) && (item.facts === undefined || object(item.facts))), `${id} expects duplicate, undeclared or malformed classes.`);
  for (const item of expect) coverage.get(step?.tool)?.add(item?.class);
  checkReferences(step?.args, `journey.${id}`, steps);
  if (step?.inject !== undefined) add(`journey.${id}.inject`, object(step.inject), `${id}.inject must be an object of additional arguments.`);
  checkReferences(step?.inject, `journey.${id}.inject`, steps);
  steps.add(step?.id);
 }
 const escalationIds = new Set(), escalationTools = new Set();
 for (const [i, step] of (Array.isArray(surface.escalations) ? surface.escalations : []).entries()) {
  const id = text(step?.id) ? step.id : `escalations[${i}]`, tool = tools.get(step?.tool);
  escalation(id, object(step) && text(step.id) && !escalationIds.has(step.id) && Boolean(tool) && object(step.args), `Invalid or duplicate escalation ${id}, tool ${JSON.stringify(step?.tool)}.`);
  escalation(`${id}.authority`, Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls)), `${id} must exercise an access or security tool.`);
  checkReferences(step?.args, `escalations.${id}`, steps, escalation);
  escalationIds.add(step?.id); escalationTools.add(step?.tool);
 }
 // Fixtures outside the journey: narrowing-only authority, native proof and durable jobs.
 const fixtures = { narrowings: tool => tool.widens === false, proofs: tool => tool.proof !== undefined, durable: tool => tool.readOnly === false }, covered = { narrowings: new Set(), proofs: new Set(), durable: new Set() };
 for (const [kind, fits] of Object.entries(fixtures)) {
  const point = kind === 'durable' ? (id, ok, detail) => points.push({ id: `BASE-AGENT-004.surface.${id}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) }) : escalation;
  point(kind, surface[kind] === undefined || Array.isArray(surface[kind]), `Agent surface ${kind} must be an array.`);
  for (const [i, step] of (Array.isArray(surface[kind]) ? surface[kind] : []).entries()) {
   const id = text(step?.id) ? step.id : `${kind}[${i}]`, tool = tools.get(step?.tool), expect = Array.isArray(step?.expect) ? step.expect : [];
   point(`${kind}.${id}`, object(step) && text(step.id) && !steps.has(step.id) && Boolean(tool) && fits(tool) && object(step.args) && expect.length > 0 && expect.every(item => object(item) && tool.classes?.includes(item.class))
    && (kind !== 'narrowings' || object(step.grants) && tools.get(step.grants.tool)?.readOnly === true && object(step.grants.args) && typeof step.grants.pointer === 'string')
    && (kind !== 'durable' || tools.has(step.runs)), `Invalid ${kind} fixture ${id}, tool ${JSON.stringify(step?.tool)}.`);
   checkReferences(step?.args, `${kind}.${id}`, steps, point);
   if (kind === 'narrowings') checkReferences(step?.grants?.args, `${kind}.${id}.grants`, steps, point);
   for (const item of expect) coverage.get(step?.tool)?.add(item?.class);
   covered[kind].add(step?.tool);
  }
 }
 for (const [name, tool] of tools) if (tool?.proof !== undefined) add(`${name}.coverage.proof`, covered.proofs.has(name), `${name} declares native proof and has no proofs fixture.`);
 for (const [name, tool] of tools) if (Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls))) {
  if (tool.widens === false) escalation(`${name}.coverage.narrowing`, covered.narrowings.has(name), `${name} declares widens:false and has no narrowing fixture.`);
  else escalation(`${name}.coverage`, escalationTools.has(name), `${name} has no sponsor escalation fixture.`);
 }
 for (const [name, tool] of tools) for (const cls of Array.isArray(tool?.classes) ? tool.classes : []) add(`${name}.coverage.${cls}`, coverage.get(name).has(cls), `${name} has no journey fixture for declared class ${cls}.`);
 add('events', tools.has(`${surface.seed}.events.list`), `Declare built-in ${surface.seed}.events.list in the Agent surface.`);
 add('witness', object(surface.witness) && tools.get(surface.witness.tool)?.readOnly === true && object(surface.witness.args), 'witness must name a declared readOnly tool and arguments.');
 checkReferences(surface.witness?.args, 'witness', new Set());
 return { ok: points.every(point => point.ok), points };
}
