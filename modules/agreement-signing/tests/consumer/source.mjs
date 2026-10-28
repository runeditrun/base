import { artifactRef, canonical, sha256 } from '../../index.ts';

/** A real native amendment publishes new immutable document versions and selected terms together. */
export async function reviseSource(env, source) {
  const definition = JSON.parse(source.definition);
  const fields = { ...JSON.parse(source.approved_fields), totalMinor: source.amount_minor + 300 };
  const oldTotal = (source.amount_minor / 100).toFixed(2);
  const newTotal = (fields.totalMinor / 100).toFixed(2);
  const oldUnit = (source.amount_minor / 300).toFixed(2);
  const newUnit = (fields.totalMinor / 300).toFixed(2);
  const writes = [];
  const documents = [];
  for (const reference of definition.documents) {
    const row = await env.DB.prepare('SELECT bytes FROM native_objects WHERE id=? AND version=?').bind(reference.id, reference.version).first();
    const content = new TextDecoder().decode(new Uint8Array(row.bytes)).replaceAll(oldTotal, newTotal).replaceAll(oldUnit, newUnit);
    const bytes = new TextEncoder().encode(content);
    // These fixture PDFs contain ASCII fixed-width amounts, so the native amendment
    // preserves their stream lengths and xref offsets while producing different bytes.
    const next = await artifactRef(reference.id, String(Number(reference.version) + 1), reference.mediaType, bytes);
    documents.push(next);
    writes.push(env.DB.prepare('INSERT INTO native_objects VALUES (?,?,?,?,?)').bind(next.id, next.version, JSON.stringify(next), bytes, source.id));
  }
  definition.documents = documents;
  definition.source.revision = String(source.revision + 1);
  definition.approvalDigest = await sha256(canonical({ documents, source: definition.source, amountMinor: fields.totalMinor }));
  definition.selectionDigest = await sha256(canonical(fields));
  writes.push(env.DB.prepare('UPDATE native_sources SET revision=revision+1,amount_minor=?,definition=?,approved_fields=? WHERE id=? AND revision=?')
    .bind(fields.totalMinor, JSON.stringify(definition), canonical(fields), source.id, source.revision));
  await env.DB.batch(writes);
  return { definition, fields };
}
