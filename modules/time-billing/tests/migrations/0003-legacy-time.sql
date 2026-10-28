-- Numbered adoption backfill: copy exact evidence without inventing duration or approvals.
INSERT INTO tb_entries(installation,id,work_kind,work_id,revision,body)
SELECT installation,id,'project','project-1',json_extract(entry_body,'$.revision'),entry_body FROM native_legacy_time;
INSERT INTO tb_entry_revisions(installation,entry_id,revision,body)
SELECT installation,id,json_extract(entry_body,'$.revision'),entry_body FROM native_legacy_time;
INSERT INTO tb_source_map(installation,source_kind,source_id,source_revision,entry_id)
SELECT installation,json_extract(entry_body,'$.source.kind'),json_extract(entry_body,'$.source.id'),json_extract(entry_body,'$.source.revision'),id FROM native_legacy_time;
INSERT INTO tb_packets(installation,id,work_kind,work_id,revision,body)
SELECT installation,json_extract(packet_body,'$.id'),'project','project-1',json_extract(packet_body,'$.revision'),packet_body FROM native_legacy_time;
INSERT INTO tb_packet_lines(installation,packet_id,ordinal,source_kind,source_id,source_revision,body)
SELECT installation,json_extract(packet_body,'$.id'),0,json_extract(packet_body,'$.lines[0].source.kind'),json_extract(packet_body,'$.lines[0].source.id'),json_extract(packet_body,'$.lines[0].source.revision'),json_extract(packet_body,'$.lines[0]') FROM native_legacy_time;
INSERT INTO tb_claims(installation,source_kind,source_id,source_revision,packet_id,revision,state,body)
SELECT installation,json_extract(claim_body,'$.source.kind'),json_extract(claim_body,'$.source.id'),json_extract(claim_body,'$.source.revision'),json_extract(claim_body,'$.packetId'),json_extract(claim_body,'$.revision'),'claimed',claim_body FROM native_legacy_time;
INSERT INTO tb_artifacts(installation,id,packet_id,digest,media_type,byte_length,bytes)
SELECT installation,json_extract(packet_body,'$.artifact.id'),json_extract(packet_body,'$.id'),artifact_digest,'text/csv',length(artifact_bytes),artifact_bytes FROM native_legacy_time;
INSERT INTO tb_timers(installation,id,work_kind,work_id,person_id,overlap_key,revision,state,body)
SELECT installation,json_extract(timer_body,'$.id'),'project','project-1','worker',NULL,json_extract(timer_body,'$.revision'),'stopped',timer_body FROM native_legacy_time;
-- Count/tie reconciliation blocks the cutover if any populated source failed to map.
INSERT INTO tb_guards(revision) SELECT CASE WHEN
  (SELECT count(*) FROM native_legacy_time)=(SELECT count(*) FROM tb_entries WHERE json_extract(body,'$.kind')='legacy')
  AND NOT EXISTS(SELECT 1 FROM native_legacy_time l LEFT JOIN tb_artifacts a ON a.installation=l.installation AND a.packet_id=json_extract(l.packet_body,'$.id') WHERE a.digest<>l.artifact_digest OR a.bytes<>l.artifact_bytes OR a.id IS NULL)
  AND NOT EXISTS(SELECT 1 FROM native_legacy_time l LEFT JOIN tb_claims c ON c.installation=l.installation AND c.packet_id=json_extract(l.packet_body,'$.id') WHERE c.body<>l.claim_body OR c.packet_id IS NULL)
  THEN 1 ELSE 0 END;
UPDATE native_control SET old_writer_stopped=1;
