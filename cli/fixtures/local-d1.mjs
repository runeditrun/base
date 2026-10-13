import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// The seed's canonical local D1 store opened in place: the same rows `wrangler d1
// execute --local` reads, without launching wrangler (seconds per call on CI).
// Returns one `{results}` per statement, in the shape wrangler prints.
export async function localD1(root,query) {
 const directory=join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
 const files=(await readdir(directory)).filter(name=>name.endsWith('.sqlite'));
 const opened=[];
 for(const name of files) {
  const db=new DatabaseSync(join(directory,name));db.exec('PRAGMA busy_timeout=10000');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='oa_operators'").get())opened.push(db);else db.close();
 }
 if(opened.length!==1){opened.forEach(db=>db.close());throw new Error(`expected one local D1 store, found ${opened.length}`);}
 const [db]=opened;
 try {
  return query.split(';').map(text=>text.trim()).filter(Boolean).map(text=>{
   const statement=db.prepare(text);
   return {results:statement.columns().length?statement.all().map(row=>({...row})):(statement.run(),[])};
  });
 }finally{db.close();}
}
