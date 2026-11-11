import { RerError } from '../errors.mjs';
import { hostedRequest } from '../hosted-owner.mjs';

// The people a flow runs as. owner is the seed's verification owner, already signed in by the install; anonymous
// has no session; signin runs its declared requests in order against the install, keeping a cookie jar and the
// values it captures by JSON pointer. Every request carries the install's Origin header.

const resolveSetup = (text, variables, where) => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name) => {
 if (!variables.has(name)) throw new RerError('size_persona_failed', `${where}: {{${name}}} has no value; an earlier request of the persona must capture it.`, 1);
 return variables.get(name);
});

/** Replaces each {{persona.var}} (or {{var}} inside a persona, when `own` is given) in `text`. */
export function fill(text, personas, where, own) {
 return text.replace(/\{\{\s*(?:([a-z][a-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, persona, name) => {
  const variables = persona === undefined ? own : personas.get(persona)?.variables;
  if (!variables?.has(name)) throw new RerError('size_flow_failed', `${where}: {{${persona ? `${persona}.` : ''}${name}}} has no value; the persona has not captured it.`, 1);
  return variables.get(name);
 });
}

const deep = (value, change) => typeof value === 'string' ? change(value) : Array.isArray(value) ? value.map(item => deep(item, change))
 : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, change)])) : value;

// The cookie jar: name=value pairs from Set-Cookie, a cookie that expires or has Max-Age 0 removed.
class Jar {
 cookies = new Map();
 constructor(header) { for (const part of header?.split(';') ?? []) { const [name, ...value] = part.trim().split('='); if (name) this.cookies.set(name, value.join('=')); } }
 keep(response) {
  for (const line of response.headers.getSetCookie()) {
   const [pair, ...attributes] = line.split(';'), at = pair.indexOf('=');
   if (at < 1) continue;
   const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
   const gone = attributes.some(attribute => {
    const [key, text = ''] = attribute.trim().split('='), lower = key.toLowerCase();
    return lower === 'max-age' ? Number(text) <= 0 : lower === 'expires' && Date.parse(text) < Date.now();
   });
   if (gone || value === '') this.cookies.delete(name); else this.cookies.set(name, value);
  }
 }
 get header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}

const pointerValue = (document, pointer) => pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
 .reduce((value, key) => value !== null && typeof value === 'object' ? value[key] : undefined, document);

/**
 * One persona of an install: `send(spec, personas, where)` makes a request as the persona. `personas` maps a name
 * to { kind, variables, send }.
 */
function persona(hosted, kind, { jar, headers = {} }) {
 const request = hostedRequest(hosted);
 const state = { kind, variables: new Map(), jar, headers };
 // spec: { method, path, body?, headers? }, every text already filled in.
 state.send = async ({ method, path, body, headers: own = {} }) => {
  const sent = new Headers({ origin: hosted.origin, ...state.headers });
  if (state.jar?.header) sent.set('cookie', state.jar.header);
  for (const [name, value] of Object.entries(own)) sent.set(name, value);
  let payload;
  if (body !== undefined) {
   payload = typeof body === 'string' ? body : JSON.stringify(body);
   if (!sent.has('content-type') && typeof body !== 'string') sent.set('content-type', 'application/json');
  }
  const response = await request(new URL(path, hosted.origin).href, { method, headers: Object.fromEntries(sent), ...(payload === undefined || method === 'GET' ? {} : { body: payload }) });
  state.jar?.keep(response);
  return response;
 };
 return state;
}

/**
 * Signs every declared persona in on a freshly built install and resolves a Map name -> persona. `ownerCookie` is
 * the owner's session cookie (what the install's bootstrap produced). A persona that cannot sign in rejects with an
 * error naming the persona, the request index and the status.
 */
export async function signPersonasIn(hosted, declared, { ownerCookie } = {}) {
 const personas = new Map();
 for (const [name, spec] of Object.entries(declared ?? {})) {
  if (spec.kind === 'owner') {
   if (ownerCookie === undefined) throw new RerError('size_persona_failed', `Persona ${name} is the owner, and this install has no owner session.`, 1);
   personas.set(name, persona(hosted, 'owner', { jar: new Jar(ownerCookie) }));
  } else if (spec.kind === 'anonymous') personas.set(name, persona(hosted, 'anonymous', {}));
  else {
   const signed = persona(hosted, 'signin', { jar: new Jar() });
   personas.set(name, signed);
   for (const [index, step] of spec.requests.entries()) {
    const where = `Persona ${name} could not sign in: requests[${index}] ${step.method} ${step.path}`;
    const own = signed.variables;
    let response;
    try {
     response = await signed.send({ method: step.method, path: resolveSetup(step.path, own, where),
      body: step.body === undefined ? undefined : deep(step.body, text => resolveSetup(text, own, where)),
      headers: Object.fromEntries(Object.entries(step.headers ?? {}).map(([key, text]) => [key, resolveSetup(text, own, where)])) });
    } catch (error) {
     if (error instanceof RerError) throw error;
     throw new RerError('size_persona_failed', `${where} failed: ${String(error?.message ?? error).slice(0, 200)}`, 1, { persona: name, request: index });
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 400) throw new RerError('size_persona_failed', `${where} answered HTTP ${response.status}.`, 1, { persona: name, request: index, status: response.status });
    if (step.capture) {
     let json;
     try { json = JSON.parse(text); } catch { throw new RerError('size_persona_failed', `${where} answered HTTP ${response.status} but not JSON, so its captures (${Object.keys(step.capture).join(', ')}) cannot be read.`, 1, { persona: name, request: index, status: response.status }); }
     for (const [variable, pointer] of Object.entries(step.capture)) {
      const value = pointerValue(json, pointer);
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw new RerError('size_persona_failed', `${where} answered HTTP ${response.status} but its response has no text or number at ${pointer} to capture as ${variable}.`, 1, { persona: name, request: index, status: response.status });
      own.set(variable, String(value));
     }
    }
   }
   // Headers sent on this persona's flows, with the captured values filled in.
   signed.headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([key, text]) => [key, resolveSetup(text, signed.variables, `Persona ${name} headers`)]));
  }
 }
 return personas;
}

/** A flow's request made as its persona: path, body and headers filled with {{persona.var}} from every persona. */
export function sendAs(personas, flow) {
 const who = personas.get(flow.persona), where = `Flow ${flow.name}`, { request } = flow;
 if (!who) throw new RerError('size_flow_failed', `${where}: persona ${flow.persona} is not signed in.`, 1);
 const text = value => fill(value, personas, where);
 return who.send({ method: request.method, path: text(request.path), body: request.body === undefined ? undefined : deep(request.body, text),
  headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key, text(value)])) });
}

/** The text of a flow's path with its templates filled, for an upgrade and for the line a person reads. */
export function pathFor(personas, flow) {
 return fill(flow.request.path, personas, `Flow ${flow.name}`);
}

/** Headers a flow's persona sends on a WebSocket upgrade: origin, the jar's cookie and the persona's headers. */
export function upgradeHeaders(personas, flow, origin) {
 const who = personas.get(flow.persona);
 const headers = new Headers({ origin, ...who.headers });
 if (who.jar?.header) headers.set('cookie', who.jar.header);
 for (const [key, value] of Object.entries(flow.request.headers ?? {})) headers.set(key, fill(value, personas, `Flow ${flow.name}`));
 return Object.fromEntries(headers);
}
