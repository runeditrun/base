import initSQLite from './vendor/wa-sqlite/wa-sqlite.mjs';

const SQLITE_ROW = 100, SQLITE_DONE = 101;

// A compiled module is supplied by the Worker bundle. Each replay opens its
// own database in memory and executes only the checkout's bundled statements.
export function sqliteMemory(module) {
 let ready;
 return async function openDatabase() {
  const sqlite = await (ready ??= initSQLite({
   instantiateWasm(imports, accept) {
    const instance = new WebAssembly.Instance(module, imports);
    accept(instance, module);
    return instance.exports;
   },
  }));
  const pointer = sqlite._malloc(4);
  if (!pointer) throw Error('Cannot allocate SQLite handle');
  let db;
  const check = code => {
   if (code !== 0) throw Error(sqlite.UTF8ToString(sqlite._sqlite3_errmsg(db)));
  };
  const withSql = (sql, operation) => {
   const size = sqlite.lengthBytesUTF8(sql) + 1, text = sqlite._malloc(size);
   if (!text) throw Error('Cannot allocate SQLite statement');
   try {
    sqlite.stringToUTF8(sql, text, size);
    check(operation(text));
   } finally {
    sqlite._free(text);
   }
  };
  const exec = sql => withSql(sql, text => sqlite._sqlite3_exec(db, text, 0, 0, 0));
  try {
   const code = sqlite.ccall('sqlite3_open', 'number', ['string', 'number'], [':memory:', pointer]);
   db = sqlite.getValue(pointer, '*');
   check(code);
   exec('PRAGMA foreign_keys=ON');
  } catch (error) {
   if (db) sqlite._sqlite3_close(db);
   sqlite._free(pointer);
   throw error;
  }
  return {
   exec,
   all(sql) {
    withSql(sql, text => sqlite._sqlite3_prepare_v2(db, text, -1, pointer, 0));
    const statement = sqlite.getValue(pointer, '*');
    try {
     const columns = Array.from({ length: sqlite._sqlite3_column_count(statement) }, (_, index) =>
      sqlite.UTF8ToString(sqlite._sqlite3_column_name(statement, index)));
     const rows = [];
     let code;
     while ((code = sqlite._sqlite3_step(statement)) === SQLITE_ROW) {
      rows.push(Object.fromEntries(columns.map((name, index) => {
       const value = sqlite._sqlite3_column_text(statement, index);
       return [name, value ? sqlite.UTF8ToString(value) : null];
      })));
     }
     if (code !== SQLITE_DONE) check(code);
     return rows;
    } finally {
     sqlite._sqlite3_finalize(statement);
    }
   },
   close() {
    sqlite._sqlite3_close(db);
    sqlite._free(pointer);
   },
  };
 };
}
