INSERT INTO as_requests (id,record_kind,definition,legacy,state,revision,created_at,restored,root,completed_artifacts)
SELECT id, 'legacy', NULL,
  json_object('recordKind','legacy','id',id,
    'source',json_object('kind','native-offer','id',source_id,'revision',source_revision),
    'kind','terms-acceptance','state','completed','originalId',id,'originalAuditRoot',audit_root,
    'historical',json_object('amountMinor',amount_minor,'currency',currency,'approvedSelection',json(approved_selection)),
    'artifacts',json_array(json(artifact)),'authentication',NULL,'consent',NULL,
    'createdAt',created_at,'restored',json('false')),
  'completed',1,created_at,0,audit_root,json_array(json(artifact))
FROM native_legacy_agreements;
INSERT INTO as_source_map (source_kind,source_id,source_revision,request_id)
SELECT 'native-offer',source_id,source_revision,id FROM native_legacy_agreements;
