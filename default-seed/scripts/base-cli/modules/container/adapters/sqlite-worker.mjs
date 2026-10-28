import { DatabaseSync } from './d1-sqlite.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { d1Preflight, d1NativeLimits } from './d1-limits.mjs';
import { sqliteError } from './sqlite-error.mjs';
const db = new DatabaseSync(workerData.path, { limits:d1NativeLimits,enableDoubleQuotedStringLiterals:true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
function execute({sql,args=[]}) {
 d1Preflight(sql,args);
 const started=performance.now(), statement=db.prepare(sql), columns=statement.columns();statement.setReturnArrays(true);
 const before=db.prepare('SELECT total_changes() AS n').get().n;
 const rawResults=columns.length ? statement.all(...args).map(row=>row.map(value=>ArrayBuffer.isView(value)?[...value]:value)) : (statement.run(...args),[]);
 const results=rawResults.map(row=>Object.fromEntries(columns.map((column,index)=>[column.name,row[index]])));
 const after=db.prepare('SELECT total_changes() AS n,last_insert_rowid() AS last_row_id').get();
 const changes=after.n-before;
 return { success:true,results,rawResults,meta:{duration:performance.now()-started,changes,last_row_id:after.last_row_id,changed_db:changes>0,rows_read:results.length,rows_written:changes},columns:columns.map(item=>item.name) };
}
parentPort.on('message',({id,operation,statements,sql})=>{
 parentPort.postMessage({id,started:true});
 try {
  let result;
  if(operation==='batch') {
   db.exec('BEGIN');try{result=statements.map(execute);db.exec('COMMIT');}catch(cause){db.exec('ROLLBACK');throw cause;}
  } else if(operation==='exec') {const start=performance.now();d1Preflight(sql);db.exec(sql);result={count:sql.split('\n').filter(line=>line.trim()).length,duration:performance.now()-start};}
  else result=execute(statements[0]);
  parentPort.postMessage({id,result});
 }catch(cause){parentPort.postMessage({id,error:sqliteError(cause)});}
});
