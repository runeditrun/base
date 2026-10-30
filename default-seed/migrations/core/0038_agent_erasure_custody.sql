ALTER TABLE agent_door_agents ADD COLUMN tombstone TEXT;
-- Installation-private replay custody, never included in an archive or export.
-- No expiry: the association replaces Base's existing indefinite replay claim.
CREATE TABLE IF NOT EXISTS agent_door_replay_aliases (
  agent TEXT NOT NULL, alias TEXT NOT NULL, call_id TEXT NOT NULL, tombstone TEXT NOT NULL,
  PRIMARY KEY(agent,alias)
);

CREATE TRIGGER person_note_erasure_capture BEFORE INSERT ON person_notes
WHEN EXISTS(SELECT 1 FROM person_erasure_redactions WHERE person_id=NEW.person_id)
 OR EXISTS(SELECT 1 FROM rer_erasure_operations WHERE entity='person' AND phase='deleting' AND json_extract(subject,'$.id')=NEW.person_id)
BEGIN SELECT RAISE(ABORT,'subject_erasure_in_progress'); END;
CREATE TRIGGER person_file_erasure_capture BEFORE INSERT ON person_files
WHEN EXISTS(SELECT 1 FROM person_erasure_redactions WHERE person_id=NEW.person_id)
 OR EXISTS(SELECT 1 FROM rer_erasure_operations WHERE entity='person' AND phase='deleting' AND json_extract(subject,'$.id')=NEW.person_id)
BEGIN SELECT RAISE(ABORT,'subject_erasure_in_progress'); END;
