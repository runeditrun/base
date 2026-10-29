import { WorkerEntrypoint } from 'cloudflare:workers';
import { application } from './application.mjs';

// This is the fixture's native worker boundary, shared by queue delivery and RPC.
export class NativeJobs extends WorkerEntrypoint {
 async enqueue(name, args, who) {
  const id = crypto.randomUUID();
  await this.env.DB.prepare('INSERT INTO fixture_jobs(id,input) VALUES(?,?)').bind(id, JSON.stringify({ name, args, who })).run();
  await this.env.JOBS.send({ id });
  return id;
 }
 async result(id) {
  const row = await this.env.DB.prepare('SELECT result FROM fixture_jobs WHERE id=?').bind(id).first();
  return row?.result ? JSON.parse(row.result) : null;
 }
}

export async function queue(batch, env) {
 const { door } = await application(env);
 for (const message of batch.messages) {
  const row = await env.DB.prepare('SELECT input FROM fixture_jobs WHERE id=?').bind(message.body.id).first();
  const { name, args, who } = JSON.parse(row.input);
  const result = await door.invoke(name, args, who);
  await env.DB.prepare('UPDATE fixture_jobs SET result=? WHERE id=?').bind(JSON.stringify(result), message.body.id).run();
  message.ack();
 }
}
