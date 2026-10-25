/** Uses the installation's already-open persistent SQLite connection. Never a home-directory job store. */
export function nativeDatabase(database) {
  const run = statement => {
    const prepared = database.prepare(statement.sql);
    return prepared.columns().length ? prepared.all(...(statement.params ?? [])) : (prepared.run(...(statement.params ?? [])), []);
  };
  return {
    async all(statement) { return run(statement); },
    async atomic(statements) {
      database.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(run); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}
