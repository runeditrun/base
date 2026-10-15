-- A person's erasure while it runs across requests: who asked, the chain of
-- queued steps that owns it, and where its import redaction stands (job ids
-- and revisions, never a value). The cron sweep continues an erasure whose
-- request or queued step was lost; the person's native erasure deletes the row.
CREATE TABLE person_erasure_redactions (
  person_id TEXT PRIMARY KEY NOT NULL,
  operator_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  continuation TEXT,
  updated_at TEXT NOT NULL
);
