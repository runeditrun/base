-- A store that applied 0018 before these triggers joined import-kit's
-- d1RetirementAppendOnly: an insert over an existing erasure journal or
-- retirement row (INSERT OR REPLACE included) is refused.
CREATE TRIGGER IF NOT EXISTS ik_d1_erasure_journal_insert BEFORE INSERT ON ik_d1_erasure_journal WHEN EXISTS(SELECT 1 FROM ik_d1_erasure_journal WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'IMPORT_ERASURE_JOURNAL_APPEND_ONLY'); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_retirement_insert BEFORE INSERT ON ik_d1_retirements WHEN EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=NEW.id AND kind=NEW.kind) BEGIN SELECT RAISE(ABORT,'IMPORT_RETIREMENT_CHANGED'); END;
