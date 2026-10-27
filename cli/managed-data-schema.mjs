import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { all, insist } from '../modules/portability/storage.mjs';
import { excludedTable } from '../modules/portability/catalogue.mjs';
import { schemaSQL } from '../modules/portability/schema-identity.mjs';
import { ensurePortabilitySchema, portabilityPlan } from '../modules/container/portability-schema.mjs';
import { ensureImportLeases } from '../modules/portability/import-lease.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';

const query = "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'";
const key = object => JSON.stringify([object.type, object.name]);
const namesHash = names => createHash('sha256').update(JSON.stringify(names.sort())).digest('hex');

// Compare the complete source inventory before policy projection can omit
// objects. Destination migrations and runtime establish native schema; only
// those migrations retire it. Source DDL is never installed. The caller has already
// validated and mapped the source migration ledger to native history.
export async function managedSchema(db, plan, policy, ledger) {
 const source = await all(db, query), scratch = new DatabaseSync(':memory:');
 const normalized = new Map();
 const identity = object => {
  if (!normalized.has(object.sql)) normalized.set(object.sql, schemaSQL(object.sql));
  return normalized.get(object.sql);
 };
 const objects = source.filter(object => ['table', 'trigger', 'index', 'view'].includes(object.type));
 const retired = new Map();
 let previous = new Map();
 try {
  for (const migration of plan) for (const sql of migration.statements) {
   scratch.exec(sql);
   const current = new Map(scratch.prepare(query).all().map(object => [key(object), object]));
   for (const object of objects) {
    const id = key(object), before = previous.get(id), after = current.get(id);
    if (before && identity(before) === identity(object) && (!after || identity(after) !== identity(object))) retired.set(id, migration.name);
   }
   previous = current;
  }
  // Native restore also installs runtime-owned bookkeeping. Derive it with
  // the same destination helpers, never a source name or a policy wildcard.
  const native = {
   prepare(sql) {
    const statement = scratch.prepare(sql);
    let values = [];
    return {
     bind(...args) { values = args; return this; },
     async first() { return statement.get(...values) ?? null; },
     async all() { return { results: statement.all(...values) }; },
     async run() { return statement.run(...values); },
    };
   },
   async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
  await ensurePortabilitySchema(native, await portabilityPlan(splitStatements));
  await ensureImportLeases(native);
  previous = new Map((await all(native, query)).map(object => [key(object), object]));
  const inventory = [], groups = new Map();
  const account = (object, disposition, migration) => {
   const group = JSON.stringify([object.type, disposition, migration]);
   if (!groups.has(group)) groups.set(group, { type: object.type, disposition, ...(migration ? { migration } : {}), names: [] });
   groups.get(group).names.push(object.name);
  };
  for (const type of ['table', 'trigger', 'index', 'view']) {
   const entries = objects.filter(object => object.type === type);
   let matched = 0;
   for (const object of entries) {
    const id = key(object), target = previous.get(id);
    if (type === 'table') {
     // Row exclusion never establishes schema compatibility. The validated
     // runner ledger is translated separately, not restored as a product table.
     if (object.name === ledger.table) { account(object, 'migration-ledger'); continue; }
     if (target) {
      if (excludedTable(object.name, policy)) account(object, 'excluded-by-policy');
      else matched++;
      continue;
     }
     const migration = retired.get(id);
     insist(excludedTable(object.name, policy) && migration, 'managed_data_schema_table_missing', 409);
     account(object, 'retired', migration);
     continue;
    }
    if (target && identity(target) === identity(object)) { matched++; continue; }
    const migration = retired.get(id);
    insist(migration, target ? 'managed_data_schema_object_unaccounted_replacement' : 'managed_data_schema_object_unknown', 409);
    account(object, target ? 'replaced' : 'retired', migration);
   }
   inventory.push({ type, source: entries.length, matched, accounted: entries.length - matched });
  }
  return { inventory, accounted: [...groups.values()].map(({ names, ...group }) => ({ ...group, count: names.length, namesSha256: namesHash(names) })) };
 } finally { scratch.close(); }
}
