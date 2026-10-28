-- Fresh schema. Copy into the NEXT unused native numbered migration.
-- Never refresh or edit a migration which an installation has applied.
CREATE TABLE co_assertions (
 id TEXT PRIMARY KEY,
 authority_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT co_authority_guard CHECK(authority_ok=1),
 revision_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT co_revision_guard CHECK(revision_ok=1),
 native_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT co_native_guard CHECK(native_ok=1)
);
CREATE TABLE co_drafts (
 installation TEXT NOT NULL, id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 actor TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), selection TEXT NOT NULL CHECK(json_valid(selection)),
 previous TEXT, review TEXT, fingerprint TEXT, frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN(0,1)),
 PRIMARY KEY(installation,id)
);
CREATE TABLE co_draft_lines (
 installation TEXT NOT NULL, draft_id TEXT NOT NULL, line_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
 PRIMARY KEY(installation,draft_id,line_id), FOREIGN KEY(installation,draft_id) REFERENCES co_drafts(installation,id)
);
CREATE TABLE co_snapshots (
 installation TEXT NOT NULL, id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('specified','legacy')), body TEXT NOT NULL CHECK(json_valid(body)), fingerprint TEXT NOT NULL,
 draft_id TEXT, draft_revision INTEGER, line_count INTEGER NOT NULL CHECK(line_count BETWEEN 0 AND 40),
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN(0,1)), origin TEXT NOT NULL CHECK(origin IN('live','restored','legacy')),
 PRIMARY KEY(installation,id), UNIQUE(installation,draft_id,draft_revision),
 CHECK(json_extract(body,'$.id')=id AND json_extract(body,'$.status')=status),
 CHECK(json_extract(body,'$.subject.kind')=subject_kind AND json_extract(body,'$.subject.id')=subject_id),
 CHECK(json_extract(body,'$.fingerprint')=fingerprint),
 CHECK((status='legacy' AND line_count=0) OR (status='specified' AND json_type(body,'$.lines')='array' AND json_array_length(body,'$.lines')=line_count))
);
CREATE TABLE co_snapshot_lines (
 installation TEXT NOT NULL, snapshot_id TEXT NOT NULL, line_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
 PRIMARY KEY(installation,snapshot_id,line_id), FOREIGN KEY(installation,snapshot_id) REFERENCES co_snapshots(installation,id),
 CHECK(json_extract(body,'$.id')=line_id)
);
CREATE TABLE co_receipts (
 installation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 operation TEXT NOT NULL, key TEXT NOT NULL, actor TEXT NOT NULL CHECK(json_valid(actor)), digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(json_valid(outcome)), live INTEGER NOT NULL CHECK(live IN(0,1)),
 UNIQUE(installation,subject_kind,subject_id,operation,key,live),
 FOREIGN KEY(installation,snapshot_id) REFERENCES co_snapshots(installation,id)
);
CREATE TABLE co_events (
 installation TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT NOT NULL, kind TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(json_valid(actor)), fingerprint TEXT NOT NULL,
 PRIMARY KEY(installation,id), FOREIGN KEY(installation,snapshot_id) REFERENCES co_snapshots(installation,id)
);
CREATE TABLE co_source_map (
 installation TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, legacy_id TEXT NOT NULL, revision TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 PRIMARY KEY(installation,source,kind,legacy_id,revision),
 FOREIGN KEY(installation,snapshot_id) REFERENCES co_snapshots(installation,id)
);
CREATE INDEX co_subject_snapshots ON co_snapshots(installation,subject_kind,subject_id,id);
CREATE UNIQUE INDEX co_one_live_receipt ON co_receipts(installation,snapshot_id) WHERE live=1;
CREATE TRIGGER co_publish BEFORE UPDATE OF published ON co_snapshots WHEN NEW.published=1 BEGIN
 SELECT CASE WHEN NEW.line_count<>(SELECT COUNT(*) FROM co_snapshot_lines WHERE installation=NEW.installation AND snapshot_id=NEW.id) THEN RAISE(ABORT,'incomplete_snapshot') END;
END;
CREATE TRIGGER co_snapshot_insert BEFORE INSERT ON co_snapshots WHEN NEW.published<>0 BEGIN SELECT RAISE(ABORT,'publish_requires_lines'); END;
CREATE TRIGGER co_snapshot_update BEFORE UPDATE ON co_snapshots WHEN OLD.published=1 BEGIN SELECT RAISE(ABORT,'immutable_snapshot'); END;
CREATE TRIGGER co_snapshot_delete BEFORE DELETE ON co_snapshots BEGIN SELECT RAISE(ABORT,'immutable_snapshot'); END;
CREATE TRIGGER co_line_insert BEFORE INSERT ON co_snapshot_lines WHEN (SELECT published FROM co_snapshots WHERE installation=NEW.installation AND id=NEW.snapshot_id)=1 BEGIN SELECT RAISE(ABORT,'immutable_snapshot'); END;
CREATE TRIGGER co_line_update BEFORE UPDATE ON co_snapshot_lines BEGIN SELECT RAISE(ABORT,'immutable_snapshot'); END;
CREATE TRIGGER co_line_delete BEFORE DELETE ON co_snapshot_lines BEGIN SELECT RAISE(ABORT,'immutable_snapshot'); END;
CREATE TRIGGER co_receipt_insert BEFORE INSERT ON co_receipts WHEN NOT EXISTS(SELECT 1 FROM co_snapshots WHERE installation=NEW.installation AND id=NEW.snapshot_id AND published=1) BEGIN SELECT RAISE(ABORT,'unpublished_receipt'); END;
CREATE TRIGGER co_receipt_live BEFORE INSERT ON co_receipts WHEN NEW.live=1 AND NOT EXISTS(SELECT 1 FROM co_snapshots WHERE installation=NEW.installation AND id=NEW.snapshot_id AND origin='live' AND draft_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inert_history'); END;
CREATE TRIGGER co_receipt_update BEFORE UPDATE ON co_receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
CREATE TRIGGER co_receipt_delete BEFORE DELETE ON co_receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
CREATE TRIGGER co_event_update BEFORE UPDATE ON co_events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
CREATE TRIGGER co_event_delete BEFORE DELETE ON co_events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
CREATE TRIGGER co_source_update BEFORE UPDATE ON co_source_map BEGIN SELECT RAISE(ABORT,'immutable_source'); END;
CREATE TRIGGER co_source_delete BEFORE DELETE ON co_source_map BEGIN SELECT RAISE(ABORT,'immutable_source'); END;
