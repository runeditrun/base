-- Keep delegated attribution through queued import-custody erasure steps.
-- Native operator_id remains the authority fence; audit_actor is attribution.
ALTER TABLE person_erasure_redactions ADD COLUMN audit_actor TEXT;
