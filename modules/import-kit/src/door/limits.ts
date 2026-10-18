import { ImportSizeLimitError } from '../d1/native-set.ts';
import { DoorError } from './grants.ts';

const codes = new Set(['IMPORT_D1_TRANSPORT_LIMIT', 'IMPORT_D1_VALUE_LIMIT', 'IMPORT_D1_STATEMENT_LIMIT']);
/** A kit size limit is a named 413, never a lineage conflict. Only the adapter's
 * target kinds are reflected, never record content. */
export function sizeLimitError(error: unknown): DoorError | undefined {
  if (!(error instanceof Error) || !codes.has(error.message)) return undefined;
  const targetKinds = error instanceof ImportSizeLimitError ? error.targetKinds : [];
  const reason = targetKinds.length
    ? `The exact native snapshot of target kind ${targetKinds.map(kind => JSON.stringify(kind)).join(', ')} exceeds one 2 MiB D1 read; the seed's target adapter needs a compact matchesMany.`
    : error instanceof ImportSizeLimitError ? 'The import custody fence exceeds one 2 MiB D1 read.' : 'A D1 statement of this import exceeds its size limit.';
  return new DoorError('import_door_too_large', 413, {targetKinds, reason});
}
