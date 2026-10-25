CREATE TABLE rer_job_jobs (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, namespace TEXT NOT NULL,
 tenant_key TEXT NOT NULL, owner_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 kind TEXT NOT NULL, handler_version INTEGER NOT NULL CHECK(handler_version>0),
 codec_version INTEGER NOT NULL CHECK(codec_version>0), source_key TEXT NOT NULL,
 operation_key TEXT NOT NULL, intent_hash TEXT NOT NULL,
 requested_revision TEXT NOT NULL, requested_revision_hash TEXT NOT NULL,
 input_ref TEXT NOT NULL, input_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','retry_wait','cancelling','cancelled','succeeded','failed','uncertain')),
 reason_code TEXT, recovery TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0), checkpoint TEXT NOT NULL DEFAULT 'null',
 checkpoint_hash TEXT NOT NULL, checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_sequence>=0),
 progress_rows INTEGER NOT NULL DEFAULT 0 CHECK(progress_rows>=0),
 progress_bytes INTEGER NOT NULL DEFAULT 0 CHECK(progress_bytes>=0),
 progress_units INTEGER NOT NULL DEFAULT 0 CHECK(progress_units>=0),
 starts INTEGER NOT NULL DEFAULT 0 CHECK(starts>=0), failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),
 result_ref TEXT NOT NULL DEFAULT 'null', result_hash TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, not_before INTEGER NOT NULL,
 deadline INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 operations_json TEXT NOT NULL DEFAULT '[]', undo_of_job_id TEXT, supersedes_job_id TEXT,
 UNIQUE(installation_id,namespace,tenant_key,principal_id,operation_key),
 UNIQUE(installation_id,id)
);
CREATE INDEX rer_job_due ON rer_job_jobs(installation_id,state,not_before,created_at,id);
CREATE INDEX rer_job_scope ON rer_job_jobs(installation_id,namespace,tenant_key,principal_id,created_at,id);
CREATE INDEX rer_job_kind ON rer_job_jobs(installation_id,kind,source_key,state);
CREATE TABLE rer_job_units (
 installation_id TEXT NOT NULL, job_id TEXT NOT NULL, unit_key TEXT NOT NULL,
 input_digest TEXT NOT NULL, output_digest TEXT NOT NULL, checkpoint_sequence INTEGER NOT NULL CHECK(checkpoint_sequence>0),
 committed_rows INTEGER NOT NULL CHECK(committed_rows>=0), committed_bytes INTEGER NOT NULL CHECK(committed_bytes>=0),
 result_ref TEXT NOT NULL, committed_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,unit_key), UNIQUE(job_id,checkpoint_sequence),
 FOREIGN KEY(installation_id,job_id) REFERENCES rer_job_jobs(installation_id,id)
);
CREATE TABLE rer_job_attempts (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, job_id TEXT NOT NULL,
 unit_sequence INTEGER NOT NULL CHECK(unit_sequence>=0), fence INTEGER NOT NULL CHECK(fence>0),
 started_at INTEGER NOT NULL, ended_at INTEGER, classification TEXT NOT NULL,
 failure_code TEXT, usage_rows INTEGER NOT NULL DEFAULT 0 CHECK(usage_rows>=0),
 usage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(usage_bytes>=0),
 UNIQUE(job_id,fence), FOREIGN KEY(installation_id,job_id) REFERENCES rer_job_jobs(installation_id,id)
);
CREATE TABLE rer_job_control (
 installation_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1),
 epoch TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('paused','running')),
 scheduler TEXT NOT NULL CHECK(scheduler IN ('native','manual')),
 holder TEXT, heartbeat INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE rer_job_activations (
 installation_id TEXT NOT NULL, job_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
 principal_id TEXT NOT NULL, owner_id TEXT NOT NULL, authorized_at INTEGER NOT NULL,
 FOREIGN KEY(installation_id,job_id) REFERENCES rer_job_jobs(installation_id,id)
);
CREATE TABLE rer_job_leases (
 installation_id TEXT NOT NULL, job_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
 holder TEXT NOT NULL, epoch TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>0),
 expires_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL,
 FOREIGN KEY(installation_id,job_id) REFERENCES rer_job_jobs(installation_id,id)
);
CREATE INDEX rer_job_lease_expiry ON rer_job_leases(installation_id,expires_at);
CREATE TRIGGER rer_job_intent_immutable BEFORE UPDATE OF installation_id,namespace,tenant_key,owner_id,principal_id,kind,handler_version,codec_version,source_key,operation_key,intent_hash,requested_revision,requested_revision_hash,input_ref,input_hash,created_at,deadline,undo_of_job_id,supersedes_job_id ON rer_job_jobs
BEGIN SELECT RAISE(ABORT,'rer_job_intent_immutable'); END;
