import { runCases } from './cases.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile,readFile,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runtime,seed,collect } from './helpers.mjs';
import { readArchive } from '../index.mjs';
const execute=promisify(execFile);
const cookie='session=synthetic-portability-cli-cookie';
export async function cliRun(cli,origin,session,command,...args) {
  try {const result=await execute(process.execPath,[cli,command,'--origin',origin,'--session-file',session,...args],{env:{...process.env,TZ:'UTC'},maxBuffer:1024*1024});return {...result,code:0};}
  catch(e){return {stdout:e.stdout??'',stderr:e.stderr??'',code:e.code};}
}
export async function cliJourney(t,cli,worker,{truncate=false}={}) {
  const previousUmask=process.umask(0o022);t.after(()=>process.umask(previousUmask));
  const source=await runtime(t,{worker,bindings:{TEST_COOKIE:cookie,TRUNCATE:truncate}}),target=await runtime(t,{worker,bindings:{TEST_COOKIE:cookie}});await seed(source);
  const origin=(await source.mf.ready).origin,other=(await target.mf.ready).origin,session=join(source.directory,'session.cookie'),out=join(source.directory,'archives','first.jsonl'),second=join(source.directory,'archives','second.jsonl');
  await writeFile(session,cookie,{mode:0o600});
  let result=await cliRun(cli,origin,session,'export','--out',out);const output=[result.stdout,result.stderr];
  if(truncate){
    assert.notEqual(result.code,0);await assert.rejects(stat(out),{code:'ENOENT'});
    const jobId=JSON.parse(await readFile(out+'.transfer.json','utf8')).id;
    assert.ok(result.stderr.includes(jobId));assert.match(result.stderr,/download.*HTTP 200.*closing_missing/);
    assert.equal((await stat(out+'.partial')).mode&0o777,0o600);
    await source.reconfigure({TRUNCATE:false});result=await cliRun(cli,(await source.mf.ready).origin,session,'export','--out',out,'--resume',jobId);
    output.push(result.stdout,result.stderr);
  }
  assert.equal(result.code,0,result.stderr);
  const imported=await cliRun(cli,other,session,'import','--from',out);assert.equal(imported.code,0,imported.stderr);output.push(imported.stdout,imported.stderr);
  const again=await cliRun(cli,other,session,'export','--out',second);assert.equal(again.code,0,again.stderr);output.push(again.stdout,again.stderr);
  const first=await readFile(out,'utf8'),last=await readFile(second,'utf8'),a=await collect(readArchive(new Response(first).body)),b=await collect(readArchive(new Response(last).body));
  await runCases(t, [['archive file observations', async t => {
  await runCases(t, [['archive content equivalence', async () => { assert.equal(a.at(-1).contentHash,b.at(-1).contentHash); }]]);
  await runCases(t, Array.from([out,out+'.transfer.json',second,second+'.transfer.json'], (file, rowIndex) => [`archive file mode row ${rowIndex + 1}`, async t => {
assert.equal((await stat(file)).mode&0o777,0o600);
}]));
  await runCases(t, Array.from([out,second], (file, rowIndex) => [`archive file identity row ${rowIndex + 1}`, async t => {
assert.equal((await stat(file)).nlink,1);await assert.rejects(stat(file+'.partial'),{code:'ENOENT'});
}]));
  await runCases(t, [['archive directory mode', async () => { assert.equal((await stat(join(source.directory,'archives'))).mode&0o777,0o700); }]]);
  await runCases(t, Array.from([...output,first,last,await readFile(out+'.transfer.json','utf8'),await readFile(second+'.transfer.json','utf8')], (text, rowIndex) => [`private CLI output row ${rowIndex + 1}`, async t => {
assert.ok(!text.includes(cookie) && !text.includes(cookie.split('=')[1]),'cookie must stay private');
}]));
  }]]);
  return {source,target,origin,session,out,cli};
}
