import type { ErrorCode } from './types.ts';
export class TimeBillingError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string = code) { super(message); this.name = 'TimeBillingError'; this.code = code; }
}
export function demand(value: unknown, code: ErrorCode = 'invalid', message?: string): asserts value {
  if (!value) throw new TimeBillingError(code, message);
}
export const LIMITS = Object.freeze({ policies: 16, packetLines: 24, exportRecords: 128, artifactBytes: 65536, jsonBytes: 131072, nativeStatements: 8, sqlParameters: 90, integerDigits: 24, decimalPlaces: 9, idLength: 128, operationLength: 128 });
