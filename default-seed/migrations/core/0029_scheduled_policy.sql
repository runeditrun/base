-- Apply as a NEW numbered migration. Authority and audit are durable, not sessions.
CREATE TABLE IF NOT EXISTS oa_policy_approvals (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT NOT NULL,
 definition TEXT NOT NULL, actions TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 approved_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS oa_policy_live ON oa_policy_approvals(policy_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS oa_policy_runs (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT,
 approval_id TEXT REFERENCES oa_policy_approvals(id), approved_by TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('running','completed','refused','failed')), error TEXT
);
CREATE INDEX IF NOT EXISTS oa_policy_runs_time ON oa_policy_runs(started_at DESC);
