import type { AgreementSigningConformanceAdapter } from '../conformance/index.mjs';
import type { ReviewRedemption, SigningOptions, SigningResult } from '../types.ts';

export function openSigningRuntime(options: Parameters<AgreementSigningConformanceAdapter['open']>[0]): Promise<
  Awaited<ReturnType<AgreementSigningConformanceAdapter['open']>> & {
    database: SigningOptions['database'];
    signWithDatabase(input: ReviewRedemption, options: { actor: string; key: string }, database: SigningOptions['database']): Promise<SigningResult>;
  }
>;
