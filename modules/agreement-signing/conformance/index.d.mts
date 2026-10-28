import type { ArtifactRef, Json, ReviewBinding, SigningDefinition, SourceRef } from '../types.ts';

export type AgreementSigningProfile = 'text-terms' | 'pdf-html-signature';
export interface AgreementSigningResponse<T = unknown> { status: number; body: T }
export interface AgreementSigningFixture {
  sourceId: string;
  definition: SigningDefinition;
  binding: ReviewBinding;
  participants: readonly { actor: string; recipientId: string }[];
  externalExecution: 'supported' | 'unsupported';
  externalArtifact?: ArtifactRef;
  drawnSignature?: ArtifactRef | null;
  /** Test-only known native credentials; none may occur in portable evidence. */
  sessionSecrets: readonly string[];
  /** Snapshot captured before the actual numbered forward migrations run. */
  legacyBefore?: {
    id: string; source: SourceRef; historical: Json; auditRoot: string | null;
    native: Json; artifact: ArtifactRef; base64: string;
  };
}
export interface AgreementSigningConformanceRuntime {
  fixture: AgreementSigningFixture;
  /** Map these operations to the adopter's actual public commands or HTTP routes.
   * Context identities must be resolved by the consumer, never accepted from input. */
  command(operation: 'prepare' | 'issue' | 'review' | 'sign' | 'close' | 'recordExternal' | 'verify' | 'restore', input: unknown,
    context: { actor: string; key: string }): Promise<AgreementSigningResponse>;
  evidence(requestId: string, actor?: string): Promise<AgreementSigningResponse>;
  download(reference: ArtifactRef, actor?: string): Promise<Response>;
  /** Read actual native source/outcomes through the adopter's public projection. */
  nativeState(): Promise<AgreementSigningResponse<{ actions: Json[]; completions: Json[]; legacy: Json }>>;
  /** Revise current native source through its actual business command. */
  reviseSource(): Promise<void>;
  /** Exercise actual native session rotation and revocation. */
  rotateSession(actor: string): Promise<void>;
  revoke(actor: string): Promise<void>;
  /** Test-only custody fault injection, never a public setup endpoint. */
  failArtifactPut(fail: boolean): Promise<void>;
  close(): Promise<void>;
}
export interface AgreementSigningConformanceAdapter {
  /** Only declared profiles run; unknown names fail instead of silently passing. */
  profiles: readonly AgreementSigningProfile[];
  /** Real disposable Worker/D1 with populated native history before forward migration.
   * Setup and custody fault injection stay outside the application's public router. */
  open(options: { profile: AgreementSigningProfile; expiresInMs?: number; legacy?: boolean }): Promise<AgreementSigningConformanceRuntime>;
}
export function registerAgreementSigningConformance(input: {
  test: (name: string, run: () => void | Promise<void>) => unknown;
  adapter: AgreementSigningConformanceAdapter;
}): void;
