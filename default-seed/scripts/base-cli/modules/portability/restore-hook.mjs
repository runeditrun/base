import { all, statement, guard, save, quote, insist, PortabilityError } from './storage.mjs';
import { sidecar, copyRowid } from './copies.mjs';
import { canonicalJson } from './hash.mjs';
import { bindCell, validateRow, writableColumns } from './catalogue.mjs';

const kinds=['password','session','api_key','passkey','oauth_token','refresh_token','delegation_issued','delegation_held'];
const opaque=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function restoreHookPolicy(input) {
  if(input===undefined)return;
  insist(input && Object.keys(input).every(key=>['registry','run'].includes(key)) && typeof input.run==='function'
    && input.registry && Object.keys(input.registry).every(key=>['table','idColumn'].includes(key))
    && [input.registry.table,input.registry.idColumn].every(value=>typeof value==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    && !/^rer_portability_/i.test(input.registry.table),'invalid_restore_hook');
  return Object.freeze({registry:Object.freeze({...input.registry}),run:input.run});
}
export async function ensureRestoreHook(db,config) {
  if(!config.restoreHook)return;
  const {table,idColumn}=config.restoreHook.registry;
  const columns=await all(db,`PRAGMA table_info(${quote(table)})`);
  insist(columns.some(c=>c.name===idColumn && c.type.toUpperCase()==='TEXT' && c.pk===1)
    && columns.filter(c=>c.pk).length===1,'invalid_restore_hook');
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS rer_portability_restore_audit (
      job TEXT NOT NULL, opaque_id TEXT NOT NULL, revocations TEXT NOT NULL,
      PRIMARY KEY(job,opaque_id)
    )`),
    ...['UPDATE','DELETE'].map(action=>db.prepare(`CREATE TRIGGER IF NOT EXISTS rer_portability_restore_audit_no_${action.toLowerCase()}
      BEFORE ${action} ON rer_portability_restore_audit BEGIN SELECT RAISE(ABORT,'append_only_restore_audit'); END`)),
  ]);
}
function registryGuard(db,registry,ids) {
  const table=quote(registry.table),column=quote(registry.idColumn);
  return guard(db,`(SELECT count(*) FROM ${table})=? AND NOT EXISTS(
    SELECT 1 FROM ${table} WHERE ${column} IS NULL OR typeof(${column})!='text'
    OR ${column} NOT IN (SELECT value FROM json_each(?)))`,ids.length,canonicalJson(ids));
}
export function restoreHookPublication(context,row) {
  const done=row.metadata.restoreHook;
  if(!context.config.restoreHook)return [];
  insist(done,'restore_hook_failed',409);
  return [registryGuard(context.db,context.config.restoreHook.registry,done.ids),
    ...done.audit.map(({opaqueId,revocations})=>statement(context.db,
      'INSERT OR IGNORE INTO rer_portability_restore_audit(job,opaque_id,revocations) VALUES(?,?,?)',row.id,opaqueId,canonicalJson(revocations)))];
}
// An explicit capability contract: no SQL or general live database handle is
// exposed. Reads see verified staging; mutations are buffered and commit with
// the hook receipt in ONE D1 batch. A failed/oversized batch changes nothing.
export async function applyRestoreHook(context,row) {
  const {db,config}=context,spec=config.restoreHook;if(!spec)return;
  const ids=(await all(db,`SELECT ${quote(spec.registry.idColumn)} AS id FROM ${quote(spec.registry.table)} ORDER BY ${quote(spec.registry.idColumn)}`)).map(r=>r.id);
  insist(ids.every(opaque) && new Set(ids).size===ids.length,'restore_hook_failed',409);
  if(row.metadata.restoreHook) {
    insist(canonicalJson(ids)===canonicalJson(row.metadata.restoreHook.ids),'restore_registry_changed',409);
    return;
  }
  const queries=[],audit=new Map();let open=true;
  const tableFor=name=>{
    insist(open,'restore_hook_failed',409);
    const table=row.metadata.targets.find(t=>t.name===name);insist(table,'restore_hook_failed',409);return table;
  };
  const whereSQL=(table,where)=>{
    insist(where && typeof where==='object' && !Array.isArray(where) && Object.keys(where).length>0,'restore_hook_failed',409);
    for(const [name,value] of Object.entries(where)) {
      const column=table.columns.find(c=>c.name===name);insist(column,'restore_hook_failed',409);
      validateRow({...table,columns:[column]},{[name]:value});
    }
    return {sql:Object.keys(where).map(c=>quote(c)+' IS ?').join(' AND '),values:Object.values(where).map(bindCell)};
  };
  const mutate=async(name,where,values)=>{
    const table=tableFor(name),copy=quote(row.metadata.copies[name]),condition=whereSQL(table,where);
    const count=(await statement(db,`SELECT count(*) AS n FROM ${copy} WHERE ${condition.sql}`,...condition.values).first()).n;
    let sql,params;
    if(values===undefined){
      insist(table.columns.some(c=>c.pk),'restore_hook_failed',409);
      sql=`DELETE FROM ${copy} WHERE ${condition.sql}`;params=condition.values;}
    else {
      insist(values && typeof values==='object' && !Array.isArray(values) && Object.keys(values).length>0,'restore_hook_failed',409);
      for(const [key,value] of Object.entries(values)) {
        const column=writableColumns(table).find(c=>c.name===key && !c.pk);insist(column,'restore_hook_failed',409);
        validateRow({...table,columns:[column]},{[key]:value});
      }
      sql=`UPDATE ${copy} SET ${Object.keys(values).map(c=>quote(c)+'=?').join(',')} WHERE ${condition.sql}`;
      params=[...Object.values(values).map(bindCell),...condition.values];
    }
    insist(open,'restore_hook_failed',409);
    queries.push(guard(db,`(SELECT count(*) FROM ${copy} WHERE ${condition.sql})=?`,...condition.values,count),
      ...(values===undefined?[statement(db,`DELETE FROM ${quote(sidecar(row.metadata.copies[name]))} WHERE rer_portability_copy_rowid IN (SELECT ${copyRowid(table)} FROM ${copy} WHERE ${condition.sql})`,...condition.values)]:[]),
      statement(db,sql,...params),guard(db,'changes()=?',count));
    return count;
  };
  const stagedDb=Object.freeze({
    async read(name,{offset=0,limit=100}={}) {
      const table=tableFor(name);
      insist(Number.isSafeInteger(offset) && offset>=0 && Number.isSafeInteger(limit) && limit>0 && limit<=1000,'restore_hook_failed',409);
      const order=table.columns.filter(c=>c.pk).map(c=>quote(c.name)).join(',') || copyRowid(table);
      return all(db,`SELECT * FROM ${quote(row.metadata.copies[name])} ORDER BY ${order} LIMIT ? OFFSET ?`,limit,offset);
    },
    delete:(name,where)=>mutate(name,where),update:(name,where,values)=>mutate(name,where,values),
  });
  const liveDb=Object.freeze({
    erasedIds:()=>[...ids],
    audit({opaqueId,revocations}) {
      insist(open && ids.includes(opaqueId) && revocations && typeof revocations==='object' && !Array.isArray(revocations)
        && Object.keys(revocations).length>0 && Object.entries(revocations).every(([kind,n])=>kinds.includes(kind) && Number.isSafeInteger(n) && n>=0),'restore_hook_failed',409);
      const entry={opaqueId,revocations:structuredClone(revocations)};
      insist(!audit.has(opaqueId) || canonicalJson(audit.get(opaqueId))===canonicalJson(entry),'restore_hook_failed',409);
      audit.set(opaqueId,entry);
    },
  });
  const before=canonicalJson(row.metadata);
  try {
    insist(await spec.run({stagedDb,liveDb,archiveManifest:structuredClone(row.metadata.manifest)})!==false,'restore_hook_failed',409);
    open=false;
    row.metadata.restoreHook={ids,audit:[...audit.values()]};
    await db.batch([guard(db,'EXISTS(SELECT 1 FROM rer_portability_jobs WHERE id=? AND metadata=?)',row.id,before),
      registryGuard(db,spec.registry,ids),...queries,save(db,row),db.prepare('DELETE FROM rer_portability_guard')]);
  }catch(error){
    open=false;
    // A lost acknowledgement may follow a durable receipt. Do not rerun or
    // discard it; a new holder will observe the atomically sanitized staging.
    const stored=await statement(db,'SELECT metadata FROM rer_portability_jobs WHERE id=?',row.id).first();
    if(JSON.parse(stored.metadata).restoreHook)throw error;
    if(!await context.importLease.owned())throw new PortabilityError('import_lease_expired',409);
    throw new PortabilityError('restore_hook_failed',409);
  }
}
