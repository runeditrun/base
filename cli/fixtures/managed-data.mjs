import { localD1 } from './local-d1.mjs';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function crc32(bytes) {
 let result = 0xffffffff;
 for (const byte of bytes) { result ^= byte; for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0); }
 return (result ^ 0xffffffff) >>> 0;
}

// Reproduce the producer's stored streaming ZIP, including data descriptors.
export function managedZip(entries) {
 const local = [], central = []; let offset = 0;
 for (const [path, value] of entries) {
  const name = Buffer.from(path), data = Buffer.isBuffer(value) ? value : Buffer.from(value), crc = crc32(data);
  const header = Buffer.alloc(30), descriptor = Buffer.alloc(16), directory = Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 6); header.writeUInt16LE(name.length, 26);
  descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(data.length, 8); descriptor.writeUInt32LE(data.length, 12);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 8);
  directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
  local.push(header, name, data, descriptor); central.push(directory, name); offset += header.length + name.length + data.length + descriptor.length;
 }
 const end = Buffer.alloc(22), directory = Buffer.concat(central);
 end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
 return Buffer.concat([...local, directory, end]);
}

// Synthetic data from the existing runnable reference fixture. Schema and rows
// are read through its database command, in the same SQL shape as the producer.
export async function managedEntries(source) {
 const query = async sql => (await localD1(source.root, sql))[0].results;
 const schema = await query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
 let sql = 'PRAGMA defer_foreign_keys=ON;\n';
 for (const table of schema.filter(row => row.type === 'table')) {
  sql += table.sql + ';\n';
  const columns = (await query(`PRAGMA table_xinfo(${quote(table.name)})`)).filter(column => !column.hidden);
  const rows = await query(`SELECT ${columns.map((column, i) => `quote(${quote(column.name)}) AS ${quote('c' + i)}`).join(',')} FROM ${quote(table.name)} ORDER BY rowid`);
  for (const row of rows) sql += `INSERT INTO ${quote(table.name)} VALUES(${columns.map((_, i) => row['c' + i]).join(',')});\n`;
 }
 for (const object of schema.filter(row => row.type !== 'table')) sql += object.sql + ';\n';
 const data = Buffer.from(sql), migrationLedger = await query('SELECT name,sha256 FROM rer_migrations ORDER BY name');
 const database = { binding: 'DB', name: 'synthetic-base-1', dumpPath: 'data/d1/DB.sql', dumpBytes: data.length, dumpSha256: hash(data), dumpEtag: 'synthetic-base-1', retryCount: 0, migrationLedger, omittedTables: [], consistency: { mode: 'paged-read-committed', snapshot: false, limitation: 'synthetic-base-1' } };
 const manifest = { schema: 1, kind: 'runeditrun-app-data', installationId: 'synthetic-base-1', appName: 'synthetic-base-1', generatedAt: '2026-10-27T00:00:00.000Z', databases: [database], buckets: [], notIncluded: [] };
 return [['data/d1/DB.sql', data], ['data/d1/DB.json', JSON.stringify(database)], ['data/d1/DB-migrations.json', JSON.stringify(migrationLedger)], ['README.txt', 'synthetic-base-1'], ['manifest.json', JSON.stringify(manifest)]];
}
