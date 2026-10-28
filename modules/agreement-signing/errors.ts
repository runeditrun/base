import type { SigningErrorCode } from './types.ts';
const status: Record<SigningErrorCode, number> = {
  invalid_input: 400, capacity: 413, unauthorized: 403, not_found: 404, conflict: 409, replay_mismatch: 409,
  stale: 409, expired: 410, closed: 409, wrong_participant: 403, ordering: 409, credential: 403,
  review_used: 409, unsupported: 422, artifact_missing: 422, artifact_mismatch: 422,
  legacy_read_only: 409, restored_inert: 409, unavailable: 503,
};
export class SigningError extends Error {
  readonly code: SigningErrorCode;
  readonly status: number;
  constructor(code: SigningErrorCode, cause?: unknown) { super(code, { cause }); this.name = 'SigningError'; this.code = code; this.status = status[code]; }
}
export function requireThat(value: unknown, code: SigningErrorCode = 'invalid_input'): asserts value {
  if (!value) throw new SigningError(code);
}
