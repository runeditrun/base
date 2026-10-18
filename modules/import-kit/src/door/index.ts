import type { ImportDoorOptions } from './types.ts';
import { admit, enabled } from './admission.ts';
import { createDoorHandler } from './handler.ts';
import { DoorError } from './grants.ts';
export type * from './types.ts';
export type { DoorAction, DoorGrant } from './grants.ts';
export { verifyImportGrant, DoorError } from './grants.ts';
export { importDoorSchema } from './schema.ts';
export { writeImportDoorSettings, readImportDoorHistory } from './authority.ts';
export { createImportOperatorHandler } from './operator.ts';

/** Grant mount: disabled until a trusted key ring and explicit opt-in exist. */
export function createImportDoorHandler(options: ImportDoorOptions): (request: Request)=>Promise<Response|null> {
  if (options.installationId !== undefined && (typeof options.installationId !== 'string' || !options.installationId.trim())) throw new DoorError('invalid_configuration',503);
  return createDoorHandler(options, '/api/rer/import/', (request, action) => admit(options,request,action),
    undefined, async () => !!options.claim?.publicKeys && Object.keys(options.claim.publicKeys).length > 0 && await enabled(options));
}
