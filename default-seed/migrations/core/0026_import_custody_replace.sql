-- import-kit d1CustodyStateReplaceSchema, after 0018 (d1CustodyStateSchema and
-- d1RetirementSchema). SQLite's REPLACE deletes the row it conflicts with without
-- firing DELETE triggers: an insert over a custody counter is ignored, a job id
-- that exists or was retired is refused, and an insert that would replace a claim,
-- provenance, history, stream page or stream row advances its owners' revisions.
CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_insert BEFORE INSERT ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_custody_states WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_job_reuse BEFORE INSERT ON ik_jobs WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=NEW.id AND kind='job') BEGIN SELECT RAISE(ABORT,'IMPORT_JOB_ID_REUSED'); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_sources_replace BEFORE INSERT ON ik_sources BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_sources WHERE identity=NEW.identity); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_provenance_replace BEFORE INSERT ON ik_provenance BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_provenance WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_provenance WHERE NEW.reversed=0 AND reversed=0 AND destination=NEW.destination AND target_kind=NEW.target_kind AND target_id=NEW.target_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_history_replace BEFORE INSERT ON ik_d1_history BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_history WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_d1_history WHERE successor_id=NEW.successor_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_stream_pages_replace BEFORE INSERT ON ik_d1_stream_pages BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.stream_id AND ordinal=NEW.ordinal); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_streams_replace BEFORE INSERT ON ik_d1_streams BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.id UNION ALL SELECT p.job_id FROM ik_d1_streams s JOIN ik_d1_stream_pages p ON p.stream_id=s.id WHERE s.destination=NEW.destination AND s.principal_id=NEW.principal_id AND s.operation_key=NEW.operation_key); END;
