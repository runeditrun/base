ALTER TABLE rer_job_control ADD COLUMN admission_cursor TEXT NOT NULL DEFAULT '';
CREATE INDEX rer_job_waiting ON rer_job_jobs(installation_id,state,id);
