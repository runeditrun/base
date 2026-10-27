import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { all, insist } from '../modules/portability/storage.mjs';
import { excludedTable } from '../modules/portability/catalogue.mjs';
import { schemaSQL } from '../modules/portability/schema-identity.mjs';

const query = "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'";
const key = object => JSON.stringify([object.type, object.name]);
const namesHash = names => createHash('sha256').update(JSON.stringify(names.sort())).digest('hex');

// Compare the complete source inventory before policy projection can omit
// objects. Only destination migrations establish or retire native schema;
// source DDL is never installed in the destination.
export async function managedSchema(db, plan, policy) {
 const source = await all(db, query), scratch = new DatabaseSync(':memory:');
 const normalized = new Map();
 const identity = object => {
  if (!normalized.has(object.sql)) normalized.set(object.sql, schemaSQL(object.sql));
  return normalized.get(object.sql);
 };
 const objects = source.filter(object => ['trigger', 'index', 'view'].includes(object.type));
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
  for (const table of source.filter(object => object.type === 'table' && !excludedTable(object.name, policy))) {
   insist(previous.has(key(table)), 'managed_data_schema_table_missing', 409);
  }
  const inventory = [], groups = new Map();
  for (const type of ['trigger', 'index', 'view']) {
   const entries = objects.filter(object => object.type === type);
   let matched = 0;
   for (const object of entries) {
    const id = key(object), target = previous.get(id);
    if (target && identity(target) === identity(object)) { matched++; continue; }
    const migration = retired.get(id);
    insist(migration, target ? 'managed_data_schema_object_unaccounted_replacement' : 'managed_data_schema_object_unknown', 409);
    const disposition = target ? 'replaced' : 'retired', group = JSON.stringify([type, disposition, migration]);
    if (!groups.has(group)) groups.set(group, { type, disposition, migration, names: [] });
    groups.get(group).names.push(object.name);
   }
   inventory.push({ type, source: entries.length, matched, accounted: entries.length - matched });
  }
  return { inventory, accounted: [...groups.values()].map(({ names, ...group }) => ({ ...group, count: names.length, namesSha256: namesHash(names) })) };
 } finally { scratch.close(); }
}
