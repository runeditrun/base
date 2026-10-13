export function faultDatabase(db,hook) {
  function prepare(sql){const raw=db.prepare(sql);return wrap(raw,sql);}
  function wrap(raw,sql){return {sql,raw,bind(...args){return wrap(raw.bind(...args),sql);},all(){return raw.all();},first(...args){return raw.first(...args);},run(){return raw.run();}};}
  return {prepare,async batch(statements){return hook(statements.map(x=>x.sql),()=>db.batch(statements.map(x=>x.raw)));}};
}
