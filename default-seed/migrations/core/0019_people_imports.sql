-- People can arrive through Base import-kit: this marks an imported row with the
-- kit's applied revision, so undo knows the row is the import's own.
ALTER TABLE people ADD COLUMN import_revision TEXT;
