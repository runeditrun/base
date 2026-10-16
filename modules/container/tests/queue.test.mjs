import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Jobs} from '../adapters/jobs.mjs';
test('durable queue reclaims an interrupted consumer, respects retries and reports dead jobs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-durable-queue-'));let db=new DatabaseSync(join(directory,'queue.sqlite'));
 try{
  const queue=new Jobs(db,'mail',{maxRetries:1,visibilitySeconds:0});
  await assert.rejects(queue.send({value:undefined}));await assert.rejects(queue.sendBatch([{body:{id:'first'}},{body:undefined}]));
  await queue.send({id:'mail'});
  // Leave a committed claim exactly as a killed process would leave it.
  db.prepare("UPDATE platform_jobs SET state='claimed',claimed_until=0,token='interrupted',attempts=1").run();db.close();db=new DatabaseSync(join(directory,'queue.sqlite'));
  const resumed=new Jobs(db,'mail',{maxRetries:1});let deliveries=0;
  await resumed.drain(async batch=>{deliveries+=batch.messages.length;assert.equal(batch.messages[0].body.id,'mail');assert.ok(batch.messages[0].attempts>1);batch.messages[0].ack();});
  await resumed.drain(async batch=>{deliveries+=batch.messages.length;});assert.equal(deliveries,1);
  await resumed.send({id:'retry'});await resumed.drain(async batch=>batch.retryAll({delaySeconds:0}));await resumed.drain(async batch=>batch.retryAll({delaySeconds:0}));assert.ok(resumed.dead()>0);
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
