import { createPortability, createPortabilityHandler, readArchive, type ArchivePolicy, type Row, type SafetyChange } from '../index.mjs';
declare const db: D1Database;
declare const bucket: R2Bucket;
const policy:ArchivePolicy={
  product:'fixture',buckets:{FILES:{}},exportRow:(_table,row):Row=>row,
  importSafety:{connections:{status:['inactive'],token:[null]}},
  importRow:(_table,row):Row=>({...row,status:'inactive',token:null}),
  validateStaged:async staged=>(await staged.read('connections')).every(row=>row.status==='inactive'&&row.token===null),
};
const service=await createPortability({db,buckets:{FILES:bucket},policy});
const id:string=await service.exports.create();
const statements:D1PreparedStatement[]=await service.erasureStatements('notes',{id:'one'});
const handler:(request:Request)=>Promise<Response|null>=await createPortabilityHandler({db,buckets:{FILES:bucket},policy,appOrigin:'https://example.test',authorize:async()=> 'owner'});
for await(const record of readArchive(await service.exports.download(id)))if(record.kind==='part')await service.imports.uploadPart('target',record.index,record);
const restored=await service.imports.finalize('target',{archiveHash:'verified-archive-hash'});
const safetyChanges:SafetyChange[]=restored.safetyChanges??[];
const changedRows:number=safetyChanges.reduce((total,change)=>total+change.rows,0);
void [statements,handler,changedRows];
