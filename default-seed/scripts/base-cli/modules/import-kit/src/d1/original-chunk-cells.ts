// Version 3 stores canonical base64. Project it as text when reading custody
// so D1 doesn't expand every byte to a number in its JSON response.
export const originalChunkColumns = `job_id,kind,original_key,ordinal,CASE
  WHEN EXISTS(SELECT 1 FROM ik_original_sets s WHERE s.job_id=ik_d1_original_chunks.job_id AND s.version=3)
    AND typeof(bytes)='blob' THEN CAST(bytes AS TEXT) ELSE bytes END AS bytes`;

// A version 3 guard compares exact bytes across old TEXT and new BLOB rows.
export const originalChunkEquals = (expected: string) =>
  `(typeof(t.bytes) IN ('blob','text') AND CAST(t.bytes AS BLOB) IS ${expected})`;
