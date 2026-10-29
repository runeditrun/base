import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

/** Load test tooling before starting the disposable installation. */
export async function verificationAgentInitializer(root, declaration) {
 if (declaration === undefined) return undefined;
 const invalid = () => new RerError('agent_initializer_invalid', 'verification.agent must name a contained initializer module with a function default export.', 1);
 if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
  || Object.keys(declaration).join(',') !== 'initializer' || typeof declaration.initializer !== 'string') throw invalid();
 let initialize;
 try {
  await contained(root, declaration.initializer);
  initialize = (await import(pathToFileURL(resolve(root, declaration.initializer)))).default;
  if (typeof initialize !== 'function') throw invalid();
 } catch { throw invalid(); }
 return ({ agentId, person, request, origin, mail, fixtures }) => initialize({ agentId, origin, email: person.email, sub: person.sub, mail, fixtures,
  request: (absolute, { headers, ...init } = {}) => {
   const sessionHeaders = new Headers(headers);
   sessionHeaders.set('Origin', origin);
   sessionHeaders.set('Cookie', person.cookie);
   if (!sessionHeaders.has('Content-Type')) sessionHeaders.set('Content-Type', 'application/json');
   return request(new URL(absolute, origin).href, { ...init, headers: sessionHeaders });
  },
 });
}
