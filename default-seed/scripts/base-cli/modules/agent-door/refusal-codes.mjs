// Refusal codes the door itself returns, documented in README. The Business
// decision read (BASE-AGENT-014) shows these as themselves; a seed's native
// codes show only when it declares them for its /docs/agents.
export const DOOR_REFUSAL_CODES = Object.freeze([
 'agents_paused', 'approval_evidence_changed', 'approval_expired', 'approval_rejected', 'approval_required',
 'budget_exhausted', 'call_in_progress', 'capability_not_declared', 'company_policy_denied', 'company_policy_invalid',
 'company_policy_unavailable', 'consent_revoked', 'decision_busy', 'idempotency_conflict', 'idempotency_key_required',
 'insufficient_scope', 'invalid_arguments', 'narrowing_contract_violation', 'native_proof_required', 'operation_mismatch',
 'policy_blocked', 'policy_unavailable', 'policy_unset', 'resource_changed', 'resource_unavailable', 'review_required',
 'revision_conflict', 'self_escalation', 'sponsor_unavailable', 'subject_erased', 'subject_erasure_in_progress',
 'target_invalid', 'tool_not_found', 'unauthenticated', 'undeclared_arguments',
]);

/** The public code for a call outcome: documented codes as themselves, any other refusal as `refused`. */
export function publicCode(outcome, code, documented = []) {
 if (outcome !== 'refused') return null;
 return typeof code === 'string' && (DOOR_REFUSAL_CODES.includes(code) || documented.includes(code)) ? code : 'refused';
}
