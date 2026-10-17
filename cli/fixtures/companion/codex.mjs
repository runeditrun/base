#!/usr/bin/env node
// A stand-in for `codex app-server` speaking its JSONL protocol. It runs where
// the companion runs it, inside the OS boundary, and writes what it could and
// could not do into the workspace, so the published patch carries the proof.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

appendFileSync(join(process.env.HOME, 'spawns'), `${process.pid}\n`);
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const attempt = work => { try { work(); return 'allowed'; } catch (error) { return error.code ?? 'denied'; } };
const seen = { args: process.argv.slice(2), env: Object.keys(process.env).sort() };
let buffer = '', thread = 'thread-1', turn = 'turn-1', fixture;
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
 buffer += chunk;
 for (let end; (end = buffer.indexOf('\n')) >= 0;) {
  const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') { seen.thread = message.params; send({ id: message.id, result: { thread: { id: thread } } }); }
  else if (message.method === 'turn/start') {
   seen.turn = { ...message.params, input: undefined };
   fixture = JSON.parse(/FIXTURE (\{.*\})/.exec(message.params.input[0].text)[1]);
   send({ id: message.id, result: { turn: { id: turn } } });
   const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
   send({ method: 'item/completed', params: { threadId: thread, item: { text: `credential echo ${auth.tokens.access_token}` } } });
   if (fixture.mode === 'hang') return;
   send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, command: 'curl example.test' } });
  } else if (message.id === 'approval-1') {
   seen.approval = message.result;
   seen.workspaceWrite = attempt(() => writeFileSync('change.txt', 'changed by provider\n'));
   seen.outsideRead = attempt(() => readFileSync(fixture.canary));
   seen.outsideWrite = attempt(() => writeFileSync(fixture.outside, 'escaped'));
   seen.symlinkRead = attempt(() => readFileSync('canary-link'));
   seen.outsideExists = existsSync(fixture.outside);
   writeFileSync('observed.json', JSON.stringify(seen, null, 1) + '\n');
   send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  }
 }
});
