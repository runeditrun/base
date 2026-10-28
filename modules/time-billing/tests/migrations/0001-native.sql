-- Existing consumer schema: these native people, permissions and accounting rows remain native.
CREATE TABLE native_people (installation TEXT NOT NULL, id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(installation,id));
CREATE TABLE native_work (installation TEXT NOT NULL, id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(installation,id));
CREATE TABLE native_sessions (token TEXT PRIMARY KEY, person_id TEXT NOT NULL, agent_id TEXT, sponsor_id TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE native_memberships (
  installation TEXT NOT NULL, person_id TEXT NOT NULL, work_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, can_read INTEGER NOT NULL, can_capture INTEGER NOT NULL,
  can_review INTEGER NOT NULL, can_finance INTEGER NOT NULL, timekeeper_id TEXT,
  PRIMARY KEY(installation,person_id,work_id)
);
CREATE TABLE native_access_policy (installation TEXT PRIMARY KEY, revision TEXT NOT NULL);
CREATE TABLE native_capture_policy (installation TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(installation,id));
CREATE TABLE native_review_policy (installation TEXT NOT NULL, work_id TEXT NOT NULL, revision TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(installation,work_id));
CREATE TABLE native_sources (installation TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, work_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(installation,kind,id));
CREATE TABLE native_rates (installation TEXT NOT NULL, work_id TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, minor_numerator TEXT NOT NULL, duration_denominator TEXT NOT NULL, currency TEXT NOT NULL, effective_at TEXT NOT NULL, PRIMARY KEY(installation,work_id));
CREATE TABLE native_adjustments (installation TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, amount_minor TEXT NOT NULL, currency TEXT NOT NULL, engine TEXT NOT NULL, calculation_revision TEXT NOT NULL, PRIMARY KEY(installation,id));
CREATE TABLE native_control (installation TEXT PRIMARY KEY, current_time TEXT NOT NULL, fail_outcome INTEGER NOT NULL DEFAULT 0, old_writer_stopped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE native_outcomes (
  installation TEXT NOT NULL, person_id TEXT NOT NULL, action TEXT NOT NULL, operation_key TEXT NOT NULL, subject TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(installation,person_id,action,subject,operation_key)
);
CREATE TABLE native_bills (installation TEXT NOT NULL, packet_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('approved','cancelled')), amount_minor TEXT NOT NULL, currency TEXT NOT NULL, PRIMARY KEY(installation,packet_id));
CREATE TRIGGER native_outcome_failure BEFORE INSERT ON native_outcomes
WHEN (SELECT fail_outcome FROM native_control WHERE installation=NEW.installation)=1
BEGIN SELECT RAISE(ABORT,'native_outcome_refused'); END;
-- Already populated history, kept readable until the cutover marker stops its sole writer.
CREATE TABLE native_legacy_time (installation TEXT NOT NULL, id TEXT NOT NULL, entry_body TEXT NOT NULL, packet_body TEXT NOT NULL, claim_body TEXT NOT NULL, timer_body TEXT NOT NULL, artifact_bytes BLOB NOT NULL, artifact_digest TEXT NOT NULL, PRIMARY KEY(installation,id));
