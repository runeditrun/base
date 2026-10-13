// Test-only snapshots of real D1. Migrations run before capture, never per case.
const quote = value => `"${value.replaceAll('"', '""')}"`;
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND sql IS NOT NULL ORDER BY rowid").all().then(result => result.results);

async function tables(db, definitions, known = []) {
  return Promise.all(definitions.filter(item => item.type === 'table').map(async item => {
    const same = known.find(table => table.name === item.name && table.sql === item.sql);
    return same ?? { ...item, parents: (await db.prepare(`PRAGMA foreign_key_list(${quote(item.name)})`).all()).results.map(key => key.table) };
  }));
}

// Child-first deletion avoids ON DELETE RESTRICT as well as ordinary FK checks.
function childFirst(tables) {
  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(table) {
    if (visited.has(table.name) || visiting.has(table.name)) return;
    visiting.add(table.name);
    for (const child of tables) if (child.parents.includes(table.name)) visit(child);
    visiting.delete(table.name); visited.add(table.name); ordered.push(table);
  }
  for (const table of tables) visit(table);
  return ordered;
}

export async function captureD1Baseline(db) {
  const definitions = await schema(db);
  const baselineTables = await tables(db, definitions);
  const rows = new Map();
  for (const table of baselineTables) rows.set(table.name, (await db.prepare(`SELECT * FROM ${quote(table.name)}`).all()).results);
  const hasSequence = await db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").first();
  const sequences = hasSequence ? (await db.prepare('SELECT name,seq FROM sqlite_sequence').all()).results : [];

  return async function restoreD1Baseline(database = db) {
    const current = await schema(database);
    const currentTables = await tables(database, current, baselineTables);
    const statements = ['PRAGMA defer_foreign_keys=ON'];
    // Last-owner and immutable-plan triggers must not fire during restoration.
    for (const item of current.filter(item => item.type !== 'table')) statements.push(`DROP ${item.type.toUpperCase()} ${quote(item.name)}`);
    for (const table of childFirst(currentTables)) statements.push(`DELETE FROM ${quote(table.name)}`);
    const changed = new Set(currentTables.filter(table => !baselineTables.some(base => base.name === table.name && base.sql === table.sql)).map(table => table.name));
    for (const table of childFirst(currentTables)) if (changed.has(table.name)) statements.push(`DROP TABLE ${quote(table.name)}`);
    for (const table of [...childFirst(baselineTables)].reverse()) {
      if (changed.has(table.name) || !currentTables.some(item => item.name === table.name)) statements.push(table.sql);
    }
    const prepared = statements.map(statement => database.prepare(statement));
    for (const table of [...childFirst(baselineTables)].reverse()) for (const row of rows.get(table.name)) {
      const columns = Object.keys(row);
      prepared.push(database.prepare(`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...Object.values(row)));
    }
    // sqlite_sequence survives DELETE and DROP; restore its actual captured values.
    if (hasSequence || currentTables.some(table => /AUTOINCREMENT/i.test(table.sql))) {
      prepared.push(database.prepare('DELETE FROM sqlite_sequence'));
      for (const row of sequences) prepared.push(database.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').bind(row.name, row.seq));
    }
    for (const item of definitions.filter(item => item.type !== 'table')) prepared.push(database.prepare(item.sql));
    prepared.push(database.prepare('PRAGMA defer_foreign_keys=OFF'));
    await database.batch(prepared);
  };
}
