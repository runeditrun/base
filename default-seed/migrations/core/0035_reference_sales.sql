-- Optional reference adoption. No source data or execution authority is seeded.
CREATE TABLE reference_sales_tenants (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
 owner_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(installation_id,tenant_key)
);
CREATE TABLE reference_sales_memberships (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, principal_id TEXT NOT NULL,
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(installation_id,tenant_key,principal_id),
 FOREIGN KEY(installation_id,tenant_key) REFERENCES reference_sales_tenants(installation_id,tenant_key)
);
CREATE TABLE reference_sales_sources (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, source_id TEXT NOT NULL,
 current_revision TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(installation_id,tenant_key,source_id)
);
CREATE TABLE reference_sales_revisions (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, source_id TEXT NOT NULL,
 revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','ready','erased')),
 row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count>=0),
 total_minor INTEGER NOT NULL DEFAULT 0 CHECK(total_minor>=0 AND total_minor<=9007199254740991),
 PRIMARY KEY(installation_id,tenant_key,source_id,revision),
 FOREIGN KEY(installation_id,tenant_key,source_id) REFERENCES reference_sales_sources(installation_id,tenant_key,source_id)
);
CREATE TABLE reference_sales_rows (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, source_id TEXT NOT NULL,
 revision TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>0),
 sale_id TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>=0 AND amount_minor<=1000000000),
 currency TEXT NOT NULL CHECK(currency='USD'),
 PRIMARY KEY(installation_id,tenant_key,source_id,revision,ordinal),
 UNIQUE(installation_id,tenant_key,source_id,revision,sale_id),
 FOREIGN KEY(installation_id,tenant_key,source_id,revision) REFERENCES reference_sales_revisions(installation_id,tenant_key,source_id,revision)
);
CREATE TRIGGER reference_sales_rows_insert BEFORE INSERT ON reference_sales_rows
 WHEN NOT EXISTS(SELECT 1 FROM reference_sales_revisions r WHERE r.installation_id=NEW.installation_id AND r.tenant_key=NEW.tenant_key AND r.source_id=NEW.source_id AND r.revision=NEW.revision AND r.state='draft')
 BEGIN SELECT RAISE(ABORT,'sales_revision_immutable'); END;
CREATE TRIGGER reference_sales_rows_update BEFORE UPDATE ON reference_sales_rows
 BEGIN SELECT RAISE(ABORT,'sales_rows_immutable'); END;
CREATE TRIGGER reference_sales_rows_delete BEFORE DELETE ON reference_sales_rows
 WHEN EXISTS(SELECT 1 FROM reference_sales_revisions r WHERE r.installation_id=OLD.installation_id AND r.tenant_key=OLD.tenant_key AND r.source_id=OLD.source_id AND r.revision=OLD.revision AND r.state='ready')
 BEGIN SELECT RAISE(ABORT,'sales_revision_immutable'); END;
CREATE TABLE reference_sales_published_rows (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, job_id TEXT NOT NULL,
 source_id TEXT NOT NULL, revision TEXT NOT NULL, ordinal INTEGER NOT NULL,
 sale_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
 PRIMARY KEY(installation_id,job_id,ordinal)
);
CREATE TABLE reference_sales_results (
 installation_id TEXT NOT NULL, tenant_key TEXT NOT NULL, job_id TEXT NOT NULL,
 source_id TEXT NOT NULL, revision TEXT NOT NULL,
 row_count INTEGER NOT NULL, total_minor INTEGER NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
 PRIMARY KEY(installation_id,job_id)
);
