-- Fresh schema. Copy into a NEW unused numbered adopter migration; never refresh applied SQL.
PRAGMA foreign_keys = ON;
CREATE TABLE tb_guards (
  authority INTEGER NOT NULL DEFAULT 1 CONSTRAINT tb_forbidden CHECK(authority=1),
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT tb_conflict CHECK(revision=1),
  custody INTEGER NOT NULL DEFAULT 1 CONSTRAINT tb_custody CHECK(custody=1)
);
CREATE TABLE tb_entries (
  installation TEXT NOT NULL, id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL CHECK(json_valid(body)),
  PRIMARY KEY(installation,id),
  CHECK(json_extract(body,'$.id')=id AND json_extract(body,'$.revision')=revision)
);
CREATE INDEX tb_entries_work ON tb_entries(installation,work_kind,work_id,id);
CREATE TABLE tb_entry_revisions (
  installation TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(installation,entry_id,revision),
  FOREIGN KEY(installation,entry_id) REFERENCES tb_entries(installation,id)
);
CREATE TABLE tb_timers (
  installation TEXT NOT NULL, id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL,
  person_id TEXT NOT NULL, overlap_key TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','stopped','inert')),
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(installation,id)
);
CREATE UNIQUE INDEX tb_timer_overlap ON tb_timers(installation,person_id,overlap_key) WHERE state='running' AND overlap_key IS NOT NULL;
CREATE TABLE tb_reviews (
  installation TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(installation,entry_id,revision),
  FOREIGN KEY(installation,entry_id,revision) REFERENCES tb_entry_revisions(installation,entry_id,revision)
);
CREATE TABLE tb_ratings (
  installation TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(installation,entry_id,revision,fingerprint),
  FOREIGN KEY(installation,entry_id,revision) REFERENCES tb_entry_revisions(installation,entry_id,revision)
);
CREATE TABLE tb_packets (
  installation TEXT NOT NULL, id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL CHECK(json_valid(body)),
  PRIMARY KEY(installation,id), CHECK(json_extract(body,'$.id')=id AND json_extract(body,'$.revision')=revision)
);
CREATE INDEX tb_packets_work ON tb_packets(installation,work_kind,work_id,id);
CREATE TABLE tb_artifacts (
  installation TEXT NOT NULL, id TEXT NOT NULL, packet_id TEXT NOT NULL,
  digest TEXT NOT NULL, media_type TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 65536),
  bytes BLOB NOT NULL, PRIMARY KEY(installation,id), UNIQUE(installation,packet_id), CHECK(length(bytes)=byte_length),
  FOREIGN KEY(installation,packet_id) REFERENCES tb_packets(installation,id)
);
CREATE TABLE tb_packet_lines (
  installation TEXT NOT NULL, packet_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 23),
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
  PRIMARY KEY(installation,packet_id,ordinal), UNIQUE(installation,packet_id,source_kind,source_id),
  FOREIGN KEY(installation,packet_id) REFERENCES tb_packets(installation,id)
);
CREATE TABLE tb_claims (
  installation TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT NOT NULL,
  packet_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL CHECK(state IN ('claimed','released')),
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(installation,packet_id,source_kind,source_id),
  FOREIGN KEY(installation,packet_id) REFERENCES tb_packets(installation,id)
);
-- Revision is evidence, not an escape hatch for claiming the same entitlement twice.
CREATE UNIQUE INDEX tb_active_claim ON tb_claims(installation,source_kind,source_id) WHERE state='claimed';
CREATE TABLE tb_commands (
  installation TEXT NOT NULL, actor TEXT NOT NULL, subject TEXT NOT NULL, action TEXT NOT NULL, operation_key TEXT NOT NULL,
  payload TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)),
  PRIMARY KEY(installation,actor,subject,action,operation_key)
);
CREATE TABLE tb_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX tb_events_work ON tb_events(installation,work_kind,work_id,sequence);
CREATE TABLE tb_source_map (
  installation TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT NOT NULL,
  entry_id TEXT NOT NULL, PRIMARY KEY(installation,source_kind,source_id,source_revision),
  FOREIGN KEY(installation,entry_id) REFERENCES tb_entries(installation,id)
);
CREATE TRIGGER tb_entries_revision BEFORE UPDATE ON tb_entries BEGIN
  SELECT CASE WHEN NEW.revision<>OLD.revision+1 OR NEW.work_kind<>OLD.work_kind OR NEW.work_id<>OLD.work_id
    THEN RAISE(ABORT,'tb_conflict') END;
END;
CREATE TRIGGER tb_packets_revision BEFORE UPDATE ON tb_packets BEGIN
  SELECT CASE WHEN NEW.revision<>OLD.revision+1 OR json_extract(OLD.body,'$.state')<>'prepared' AND
    NOT(json_extract(OLD.body,'$.state')='approved' AND json_extract(NEW.body,'$.state')='cancelled')
    THEN RAISE(ABORT,'tb_conflict') END;
END;
CREATE TRIGGER tb_claims_revision BEFORE UPDATE ON tb_claims BEGIN
  SELECT CASE WHEN NEW.revision<>OLD.revision+1 OR OLD.state<>'claimed' OR NEW.state<>'released'
    OR NEW.packet_id<>OLD.packet_id OR NEW.source_revision<>OLD.source_revision THEN RAISE(ABORT,'tb_conflict') END;
END;
CREATE TRIGGER tb_entry_revisions_update BEFORE UPDATE ON tb_entry_revisions BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_entry_revisions_delete BEFORE DELETE ON tb_entry_revisions BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_reviews_update BEFORE UPDATE ON tb_reviews BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_reviews_delete BEFORE DELETE ON tb_reviews BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_ratings_update BEFORE UPDATE ON tb_ratings BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_ratings_delete BEFORE DELETE ON tb_ratings BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_artifacts_update BEFORE UPDATE ON tb_artifacts BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_artifacts_delete BEFORE DELETE ON tb_artifacts BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_packet_lines_update BEFORE UPDATE ON tb_packet_lines BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_packet_lines_delete BEFORE DELETE ON tb_packet_lines BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_commands_update BEFORE UPDATE ON tb_commands BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_commands_delete BEFORE DELETE ON tb_commands BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_events_update BEFORE UPDATE ON tb_events BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_events_delete BEFORE DELETE ON tb_events BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_source_map_update BEFORE UPDATE ON tb_source_map BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
CREATE TRIGGER tb_source_map_delete BEFORE DELETE ON tb_source_map BEGIN SELECT RAISE(ABORT,'tb_immutable'); END;
