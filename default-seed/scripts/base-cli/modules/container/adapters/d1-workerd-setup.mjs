import { d1Preflight, d1ResultPreflight, d1NativeLimits, createD1RowGuard, d1ColumnCount } from './d1-limits.mjs';
// Instrument the pinned local D1 storage service, rather than only the Node
// binding: SQL issued inside a Worker must pass the same preflight. Leave the
// workerd SQLite engine intact, including its independent native limits.
const installed = Symbol.for('rer.d1.preflight');
export function installD1Preflight(plugin) {
  if (plugin[installed]) return;
  const getServices = plugin.getServices;
  plugin.getServices = async function (...args) {
    const services = await getServices.apply(this, args);
    for (const service of services) {
      if (service.name !== 'd1:db') continue;
      const module = service.worker.modules.find(module => module.name === 'database.worker.js');
      const marker = '#query = (format, query) => {';
      if (!module?.esModule?.includes(marker)) throw new Error('D1 preflight: pinned workerd query entry changed');
      const after = 'let afterTime = performance.now()';
      if (!module.esModule.includes(after)) throw new Error('D1 preflight: pinned workerd transaction entry changed');
      module.esModule = `const d1NativeLimits = ${JSON.stringify(d1NativeLimits)};\n${d1Preflight.toString()}\n${d1ResultPreflight.toString()}\n${d1ColumnCount.toString()}\nconst guardD1Rows = (${createD1RowGuard.toString()})();\n`
        + module.esModule.replace(marker, `${marker}\n    d1Preflight(query.sql, query.params ?? [], table => d1ColumnCount(table, sql => Array.from(this.db.prepare(sql)())));`)
          .replace(after, `d1ResultPreflight(rows);\n    if (this.#changes().totalChanges !== beforeChanges.totalChanges) guardD1Rows(this.db, sql => ({ get: () => { try { return Array.from(this.db.prepare(sql)())[0]; } catch (error) { throw new Error('D1 row preflight query ' + sql.slice(0,100) + ': ' + error.message); } }, all: () => { try { return Array.from(this.db.prepare(sql)()); } catch (error) { throw new Error('D1 row preflight query ' + sql.slice(0,100) + ': ' + error.message); } } }), undefined, query.sql);\n    ${after}`);

    }
    return services;
  };
  plugin[installed] = true;
}
