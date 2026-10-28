-- Additive populated adoption: original native IDs/bytes are read, never repriced.
INSERT INTO co_snapshots(installation,id,subject_kind,subject_id,status,body,fingerprint,draft_id,draft_revision,line_count,published,origin)
SELECT o.installation,o.id,o.subject_kind,o.subject_id,'legacy',
 json_object('status','legacy','id',o.id,'subject',json_object('kind',o.subject_kind,'id',o.subject_id),
 'source',json_object('source','native-orders','id',o.id,'revision',h.revision),
 'currency',h.currency,'arithmetic',h.arithmetic,'original',h.original,'fingerprint',h.fingerprint,'visibility','commercial'),
 h.fingerprint,NULL,NULL,0,0,'legacy'
FROM native_orders o JOIN native_order_history h ON h.installation=o.installation AND h.order_id=o.id
WHERE o.status='historical';
INSERT INTO co_source_map(installation,source,kind,legacy_id,revision,snapshot_id)
SELECT installation,'native-orders','order',order_id,revision,order_id FROM native_order_history;
INSERT INTO co_events(installation,id,snapshot_id,kind,actor,fingerprint)
SELECT h.installation,'upgrade:' || h.order_id,h.order_id,'legacy_import',json_object('personId',o.person_id),h.fingerprint
FROM native_order_history h JOIN native_orders o ON o.installation=h.installation AND o.id=h.order_id;
UPDATE co_snapshots SET published=1 WHERE origin='legacy' AND published=0;
-- Tie out the original IDs, source revisions and exact historical bytes before
-- the native migration runner records its atomic completion marker/cutover.
INSERT INTO co_assertions(id,revision_ok)
SELECT 'populated-upgrade',CASE WHEN
 (SELECT COUNT(*) FROM native_orders WHERE status='historical')=(SELECT COUNT(*) FROM co_snapshots WHERE origin='legacy' AND published=1)
 AND NOT EXISTS(SELECT 1 FROM native_order_history h LEFT JOIN co_snapshots s ON s.installation=h.installation AND s.id=h.order_id
  LEFT JOIN co_source_map m ON m.installation=h.installation AND m.source='native-orders' AND m.kind='order' AND m.legacy_id=h.order_id AND m.revision=h.revision
  WHERE s.id IS NULL OR m.snapshot_id<>h.order_id OR m.snapshot_id IS NULL OR json_extract(s.body,'$.original')<>h.original OR s.fingerprint<>h.fingerprint)
 THEN 1 ELSE 0 END;
DELETE FROM co_assertions;
