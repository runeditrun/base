import assert from 'node:assert/strict';
import { Miniflare,convertV4MiniflareOptions } from '../adapters/d1-workerd.mjs';
import { D1 } from '../adapters/d1.mjs';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory=await mkdtemp(join(tmpdir(),'rer-d1-differential-'));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'differential'},d1Persist:join(directory,'worker')}));
const node=new D1(join(directory,'node.sqlite'));
async function outcome(db,operation){try{return{result:await operation(db)}}catch(cause){return{error:cause.message}}}
const clean=result=>({results:result.results,success:result.success,changes:result.meta.changes,last_row_id:result.meta.last_row_id});
const corpus=[
 db=>db.prepare('INSERT INTO parent(value,blob) VALUES(?,?)').bind('é',new Uint8Array([0,255,17])).run().then(clean),
 db=>db.prepare('SELECT * FROM parent').all().then(clean),
 db=>db.prepare('SELECT blob FROM parent').first('blob'),
 db=>db.prepare('SELECT id,value,blob FROM parent').raw({columnNames:true}),
 db=>db.prepare('SELECT ? AS enabled').bind(true).first(),
 db=>db.prepare('SELECT ? AS value').bind(undefined).all(),
 db=>db.prepare('SELECT ? AS value').bind(1n).all(),
 db=>db.prepare('INSERT INTO parent(value) VALUES(?)').bind('é').run().then(clean),
 db=>db.prepare('INSERT INTO child(parent,value) VALUES(?,?)').bind(999,'orphan').run().then(clean),
 db=>db.batch([db.prepare('INSERT INTO parent(value) VALUES(?)').bind('batch'),db.prepare('INSERT INTO child(parent,value) VALUES(999,?)').bind('orphan')]).then(rows=>rows.map(clean)),
 db=>db.prepare('SELECT count(*) AS n FROM parent').first(),
 db=>db.batch([db.prepare('INSERT INTO parent(value) VALUES(?)').bind('batch'),db.prepare('INSERT INTO child(parent,value) VALUES(2,?)').bind('valid')]).then(rows=>rows.map(clean)),
 db=>db.prepare('SELECT json_extract(?,?) AS value').bind('{"n":7}','$.n').first(),
 db=>db.prepare('INSERT INTO child(parent,value) VALUES(1,NULL)').run().then(clean),
 db=>db.prepare('INSERT INTO parent(id,value) VALUES(1,?)').bind('other').run().then(clean),
 db=>db.prepare('SELECT 1 AS n').first('missing'),
 db=>db.prepare('SELECT * FROM absent').all(),
 db=>db.exec('CREATE TABLE extra(id INTEGER);\nINSERT INTO extra VALUES(1);\nINSERT INTO extra VALUES(2);').then(({count})=>({count})),
 db=>db.prepare('SELECT * FROM extra ORDER BY id').raw(),
 db=>db.prepare('SELECT parent.value,extra.id,NULL AS value FROM parent CROSS JOIN extra ORDER BY extra.id').raw({columnNames:true}),
];
try{
 const workers=await mf.getD1Database('DB');
 // Schema setup precedes application operations. Worker storage has internal writes;
 // the first application INSERT establishes the same last-row-id on both engines.
 for(const db of [workers,node]){await db.prepare('CREATE TABLE parent(id INTEGER PRIMARY KEY,value TEXT UNIQUE,blob BLOB)').run();await db.prepare('CREATE TABLE child(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parent(id),value TEXT NOT NULL)').run();}
 for(const [index,operation]of corpus.entries()){
  const a=await outcome(workers,operation),b=await outcome(node,operation);try{assert.deepEqual(b,a);}catch(cause){console.error(JSON.stringify({case:index,workers:a,node:b}));throw cause;}
 }
 console.log('D1_DIFFERENTIAL_PASS '+corpus.length);
}finally{await mf.dispose();await node.close();await rm(directory,{recursive:true,force:true});}
