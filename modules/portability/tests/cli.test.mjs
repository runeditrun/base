import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { options,cookieFile } from '../cli-options.mjs';
import { writeFile,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runtime } from './helpers.mjs';
import { cliJourney,cliRun } from './cli-journey.mjs';
const cli=new URL('../cli.mjs',import.meta.url).pathname,worker=new URL('./fixture-worker.mjs',import.meta.url).pathname;
test("archive CLI transfers require private credentials and exact safe destinations", async t => {
  const foldedCases = [];
foldedCases.push(['CLI real Worker export, import, export keeps hashes, modes and cookies private', async t=>{
  const f=await cliJourney(t,cli,worker),before=(await f.source.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').first()).n;
  const refused=await cliRun(cli,f.origin,f.session,'export','--out',f.out);assert.notEqual(refused.code,0);
  assert.equal((await f.source.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').first()).n,before);
}]);
foldedCases.push(['CLI truncated download stays partial and resume verifies before promotion', async t=>{await cliJourney(t,cli,worker,{truncate:true});}]);
foldedCases.push(['CLI refuses non-loopback HTTP origins, credentials and relative paths', async (t)=>{
  const flags=['--session-file','/absolute/cookie','--out','/absolute/archive'];
  const credentialed=new URL('https://example.test');credentialed.username='fixture-user';credentialed.password=['fixture', 'password'].join('-');
  await runCases(t, Array.from(['http://example.test','http://127.1','http://localhost.example',credentialed.href,'https://example.test/path','https://example.test?query','https://example.test#fragment'], (origin, rowIndex) => [`${t.name}: origin row ${rowIndex + 1}`, async t => {
assert.throws(()=>options(['export','--origin',origin,...flags]));
}]));
  await runCases(t, Array.from([['session-file','relative-cookie'],['out','relative-out'],['from','relative-from']], ([key,value], rowIndex) => [`${t.name}: [key,value] row ${rowIndex + 1}`, async t => {
assert.throws(()=>options([key==='from'?'import':'export','--origin','https://example.test','--session-file',key==='session-file'?value:'/absolute/cookie','--'+(key==='from'?'from':'out'),key==='session-file'?'/absolute/archive':value]));
}]));
  assert.equal(options(['export','--origin','http://[::1]:8787',...flags]).origin,'http://[::1]:8787');
}]);
foldedCases.push(['CLI session input is one small regular cookie file', async t => {
  await runCases(t, [
    ['oversized cookie file refuses', async t => {

  const f=await runtime(t),path=join(f.directory,'session');await writeFile(path,'session='+'a'.repeat(4090));await assert.rejects(cookieFile(path),/small regular/);
    }],
    ['multiple cookies refuse', async t => {

  const f=await runtime(t),path=join(f.directory,'session');
  await writeFile(path,'one=value; two=value');await assert.rejects(cookieFile(path),/one cookie/);
    }],
    ['symbolic link refuses', async t => {

  const f=await runtime(t),path=join(f.directory,'session');
  await writeFile(path,'one=value; two=value');
  const link=join(f.directory,'linked');await symlink(path,link);await assert.rejects(cookieFile(link),/small regular/);
    }]
  ]);
}]);
  await runCases(t, foldedCases);
});
