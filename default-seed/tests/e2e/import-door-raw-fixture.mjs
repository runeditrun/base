import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
export const rawDoorRecords = [
  {id:'synthetic-base-1',title:'Reset a workspace login',body:'Historical support instructions.',team:'Customer support'},
  {id:'synthetic-base-2',title:'Review a service incident',body:'Historical incident review.',team:'Operations'},
];

/** A real, deterministic one-member ZIP, built in memory rather than committed. */
export function rawDoorZip(records = rawDoorRecords, comment = Buffer.from([0xff])) {
  const name = Buffer.from('records.json'), content = Buffer.from(JSON.stringify(records));
  const compressed = deflateRawSync(content), crc = crc32(content);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(8,8);
  local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18);
  local.writeUInt32LE(content.length,22); local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6);
  central.writeUInt16LE(8,10); central.writeUInt32LE(crc,16);
  central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(content.length,24);
  central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10);
  end.writeUInt32LE(central.length + name.length,12);
  end.writeUInt32LE(local.length + name.length + compressed.length,16);
  end.writeUInt16LE(comment.length,20);
  return Buffer.concat([local,name,compressed,central,name,end,comment]);
}

/** Test seed reader: bounded inflation, ZIP headers, size and CRC before JSON. */
export function readRawDoorZip({bytes}, limits) {
  const zip = Buffer.from(bytes), name = Buffer.from('records.json');
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  assert.equal(zip.readUInt16LE(6),0); assert.equal(zip.readUInt16LE(8),8);
  assert.equal(zip.readUInt16LE(26),name.length); assert.equal(zip.readUInt16LE(28),0);
  assert.deepEqual(zip.subarray(30,30 + name.length),name);
  const compressedSize = zip.readUInt32LE(18), size = zip.readUInt32LE(22);
  assert.ok(size <= limits.maxBytes);
  const central = 30 + name.length + compressedSize, end = central + 46 + name.length;
  assert.equal(zip.readUInt32LE(central),0x02014b50);
  assert.equal(zip.readUInt32LE(end),0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10),1);
  assert.equal(zip.readUInt32LE(end + 16),central);
  assert.equal(zip.length,end + 22 + zip.readUInt16LE(end + 20));
  const content = inflateRawSync(zip.subarray(30 + name.length,central),{maxOutputLength:limits.maxBytes});
  assert.equal(content.length,size); assert.equal(crc32(content),zip.readUInt32LE(14));
  const records = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content));
  assert.ok(Array.isArray(records) && records.length <= limits.maxRecords);
  return records.map(payload => ({kind:'document',sourceId:payload.id,payload}));
}
