/* Compile fixture: the egress service binding stub, as each seed receives it, satisfies the three
 * seed contracts without changing them. Checked by tests/contracts.test.ts with workers-types. */
import type { TrustedTransport, WireRequest, WireResponse } from '../../integrations/core/types.ts';
import type { createEgressEntrypoint } from '../entrypoint.ts';
import { EGRESS_POLICY } from '../policy.ts';

type EgressService = InstanceType<ReturnType<typeof createEgressEntrypoint>>;
declare const binding: Service<EgressService>;

// Penny, just-every/feedback-penny c8e3eed, src/core/features/integrations/transport.ts:9 (copied verbatim)
export interface EnforcingEgress {send(request:WireRequest):Promise<WireResponse>}
// Penny, src/core/shared/bindings.ts:2
const penny: { PENNY_EGRESS?: EnforcingEgress } = { PENNY_EGRESS: binding };

// Vector, just-every/projects-vector 7297afe, src/core/app/bindings.ts:7-8
const vector: { INTEGRATION_EGRESS?: TrustedTransport; INTEGRATION_EGRESS_POLICY?: string } = { INTEGRATION_EGRESS: binding, INTEGRATION_EGRESS_POLICY: EGRESS_POLICY };
// Vector, src/core/features/integrations/outbound.ts:9 requires exactly this literal.
const vectorPolicy: 'public-dns-pinned-tls-v1' = EGRESS_POLICY;

// Spool, just-every/errors f4978eb, src/domain/alerts/types.ts:5
const spool: { INTEGRATION_EGRESS?: TrustedTransport } = { INTEGRATION_EGRESS: binding };

// Base's own consumers take the same stub as a TrustedTransport.
const base: TrustedTransport = binding;
// The stub is typed, not `any`: a transport answering with the wrong shape is rejected.
// @ts-expect-error
const wrongShape: { send(request: WireRequest): Promise<number> } = binding;
void [penny, vector, vectorPolicy, spool, base, wrongShape];
