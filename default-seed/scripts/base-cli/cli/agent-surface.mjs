import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { RerError } from './errors.mjs';

/** Read only edition declarations; never import the application's tool code. */
export async function readAgentSurface(root) {
 let source;
 try { source = await readFile(join(root, 'agent-surface.json'), 'utf8'); }
 catch (error) {
  if (error.code === 'ENOENT') return undefined;
  throw new RerError('agent_surface_invalid', 'Cannot read agent-surface.json. Restore the edition\'s agent declaration.', 1);
 }
 let surface;
 try { surface = JSON.parse(source); }
 catch { throw new RerError('agent_surface_invalid', 'agent-surface.json must contain valid JSON.', 1); }
 let contract;
 try { contract = await readFile(join(root, 'CONTRACT.md'), 'utf8'); }
 catch (error) { if (error.code !== 'ENOENT') throw new RerError('agent_surface_invalid', 'Cannot read CONTRACT.md to check the agent surface clauses.', 1); }
 return { surface, contract };
}

export async function agentSurfaceClauses(root) {
 let declaration;
 try { declaration = await readAgentSurface(root); }
 catch (error) {
  if (!(error instanceof RerError)) throw error;
  return [{ id: 'SC-14.agents.declaration', ok: false, message: error.message }];
 }
 if (!declaration) return [{ id: 'SC-14.agents.undeclared', ok: true }];
 return validateAgentSurface(declaration.surface, { contract: declaration.contract }).points.map(({ id, ok, detail }) => ({
  id: `SC-14.agents.${id}`, ok, ...(!ok ? { message: detail } : {}),
 }));
}
