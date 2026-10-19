import { createHmac } from 'node:crypto';
import { localVariables } from '../onboarding/local/environment.mjs';
import { personaLinks } from './fixtures/persona-links.mjs';
import { commandDiagnostic } from './fixtures/command-diagnostic.mjs';
import { originalArchiveIdentity, recoverArchiveIdentity } from './fixtures/archive-identity.mjs';
import { archiveRecords, archiveRows, archiveItems, remakeArchive } from './fixtures/archive-records.mjs';
import { signedOutSetup, ownerSetup } from './fixtures/setup-journey.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm, stat, access, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { exportReference } from '../scripts/export-reference.mjs';
import { initialize } from '../foundation/initialize.mjs';
import { assemble } from '../composition/assemble.mjs';
import { sourceRoots } from './export.mjs';
import {fixture,freePort,setupOrigin,hostStatus,pause,chromium,forwardingProxy,documentedCommand} from './fixtures/reference.mjs';
import { readDevKey } from '../modules/operator-auth/dev/sign-in-as.mjs';
import { privateRuntime } from './fixtures/private-runtime.mjs';
import { unreadableCommands } from './fixtures/run-page.mjs';
for(const kind of ['default-seed','foundation'])test(`${kind}: standalone real Worker install/setup/dev/sign-in/build/reset and teardown`,{timeout:20*60_000},async t=>{
 const f=await fixture(kind,t);let port,url;
 await t.test('frozen install and real local application lifecycle', async local=>{
 const events=child=>child.stdoutText.trim().split('\n').map(line=>JSON.parse(line));
 const guide=await readFile(join(f.root,'RUN-LOCALLY.md'),'utf8'),steps=guide.match(/```sh\n([^`]+)\n```/)?.[1].trim().split('\n');assert.ok(steps,'exported operator recipe is available to execute');
 await f.run(['check','--profile','first-party','--json']);
 await f.documented(steps[0]);
 for (const output of ['journey.json','public/x.rer','dist/client/x.rer','src/x.rer']) await f.run(['export','--output',output,'--json'],4);
 await assert.rejects(access(join(f.root,'public/x.rer')), 'refused export writes nothing');
 await f.run(['export','--output','exports/a.rer','--json']);
 for (const output of ['./exports/dotted.rer',join(f.root,'exports/absolute-inside.rer')]) {
  await f.run(['export','--output',output,'--json']);
  assert.ok((await stat(resolve(f.root,output))).size>0,'accepted export writes an archive');
 }
 await mkdir(join(f.root,'public'),{recursive:true});
 // Both the normal filename and a renamed real archive fail the real build.
 for (const name of ['x.rer','renamed.json']) {
  await cp(join(f.root,'exports/a.rer'),join(f.root,'public',name));
  const failed=await f.run(['build','--json'],1);
  assert.match(events(failed).find(event=>event.event==='error').message,/archive/i);
  await rm(join(f.root,'public',name));
 }
 await f.run(['setup','--json','--non-interactive'],3);
 const answers=join(f.root,'answers.json');await writeFile(answers,JSON.stringify({OWNER_EMAIL:'different@example.test'}),{mode:0o600});
 await f.run(['setup','--answers','answers.json','--owner-email','cli-owner@example.test','--json','--non-interactive'],2);
 await f.run(['setup','--answers','../outside.json','--json','--non-interactive'],4);
 await symlink(answers,join(f.root,'linked-answers.json'));await f.run(['setup','--answers','linked-answers.json','--json','--non-interactive'],4);await rm(join(f.root,'linked-answers.json'));await rm(answers);
 const manifestAnswers={OWNER_EMAIL:'cli-owner@example.test',...(kind==='foundation'?{WORKSPACE_TITLE:'Manifest workspace',CONNECTION_PASSWORD:'fixture-connection-passphrase'}:{})};
 await writeFile(answers,JSON.stringify(manifestAnswers),{mode:0o600});
 const setupCommand=steps[1].replace('you@example.com','cli-owner@example.test')+' --answers answers.json --owner-name CLI --non-interactive --json';
 const [setupProgram,...setupArgs]=documentedCommand(setupCommand);
 const setupResult=f.launch(setupArgs,setupProgram,{CI:'false'});
 const setupUrl=await setupOrigin(setupResult),setupPort=Number(new URL(setupUrl).port);
 await privateRuntime(`http://127.0.0.1:${setupPort}`,f.root,{kind,runtime:'setup',child:setupResult});
 assert.equal(await setupResult.done,0,'documented JSON setup passes through the real heavy-job queue');
 assert.equal(events(setupResult).filter(event=>event.event==='setup-ready').length,1,'JSON setup readiness is emitted once');
 assert.equal(events(setupResult).filter(event=>event.event==='result').length,1,'JSON setup has one closing result');
 assert.equal(events(setupResult).find(event=>event.event==='setup-ready').setupUrl,`http://127.0.0.1:${setupPort}/setup`);
 await rm(answers);
 const settings=await readFile(join(f.root,'.dev.vars'));
 if(kind==='foundation'){assert.ok(settings.includes(Buffer.from('WORKSPACE_TITLE="Manifest workspace"')),'declared public answer saved');assert.ok(settings.includes(Buffer.from('CONNECTION_PASSWORD=fixture-connection-passphrase')),'entered manifest secret saved privately');}
assert.equal((await stat(join(f.root,'.dev.vars'))).mode&0o777,0o600);
 const description=JSON.parse((await f.run(['describe','--json'])).stdoutText);assert.ok(description.verbs.dev.flags.includes('--port'));
 await f.run(['doctor','--json'],3);assert.ok(settings.equals(await readFile(join(f.root,'.dev.vars'))),'inspection preserves settings');
 await f.run(['setup','--owner-email','other-owner@example.test','--non-interactive','--json'],4);
 await f.data('CREATE TABLE cli_reset_probe (value TEXT); INSERT INTO cli_reset_probe VALUES (\'prior owner content\');');
 const repeatedSetup=f.launch(['scripts/rer.mjs','setup','--non-interactive'],process.execPath,{CI:'false'});
 assert.equal(await repeatedSetup.done,0,'setup rerun passes through the real heavy-job queue');
 assert.ok(repeatedSetup.stdoutText.includes(`http://127.0.0.1:${setupPort}/setup`),'terminal setup identifies first-run route');
 const prior=await f.data('SELECT value FROM cli_reset_probe');assert.deepEqual(prior[0].results,[{value:'prior owner content'}],'setup kept previous domain data');assert.ok(settings.equals(await readFile(join(f.root,'.dev.vars'))),'setup keeps exact private bytes');
 await f.run(['build','--json']);assert.ok(settings.equals(await readFile(join(f.root,'.dev.vars'))),'build restores exact private bytes');
 // An archive holds the installation's data: export refuses a name rer dev
 // would serve, and saves into the documented exports/ folder.
 await f.run(['export','--output','journey.json','--json'],4);
 await f.run(['export','--output','exports/journey.rer','--json']);await cp(join(f.root,'exports/journey.rer'),join(f.root,'journey.rer'));
 port=await freePort();while(port===setupPort)port=await freePort();url=`http://127.0.0.1:${port}`;
 const dev=f.start(['dev','--port',String(port),'--json','--non-interactive']);local.after(()=>f.stop(dev));
 const deadline=Date.now()+120000;while(!dev.stdoutText.includes('"event":"ready"')&&dev.exitCode===null&&Date.now()<deadline)await pause(100);
 assert.ok(dev.stdoutText.includes('"event":"ready"'),'actual dev health must precede ready');
 await privateRuntime(url,f.root,{kind,runtime:'dev'});
 const ready=events(dev).find(e=>e.event==='ready');assert.equal(ready.url,url);assert.equal(ready.signInUrl,undefined);
 // The installed instance answers its claim state publicly and shows the Lobby at /;
 // RER_SITE serves the static run site on its own loopback port.
 const claimState=async()=>{const response=await fetch(url+'/setup/state');assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('set-cookie'),null);return response.json();};
 const lobbyLinks=async()=>{const response=await fetch(url+'/');assert.equal(response.status,200);return [...(await response.text()).matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(match=>match[1]).filter(href=>href.startsWith('/'));};
 assert.deepEqual(await claimState(),{state:'claimed'},'setup claims the owner before first-run confirmation');
 assert.deepEqual(await lobbyLinks(),['/','/signin?login_hint=cli-owner%40example.test'],'the claimed Lobby offers sign-in before first-run confirmation');
 assert.equal((await fetch(url+'/setup/state',{method:'POST'})).status,405);
 assert.match(ready.siteUrl,/^http:\/\/127\.0\.0\.1:\d+$/,'rer dev names the run site preview');assert.notEqual(ready.siteUrl,url);
 for(const path of ['/','/run'])assert.equal((await fetch(ready.siteUrl+path)).status,200,`run site preview ${path}`);
 {const pageBrowser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});try{assert.deepEqual(await unreadableCommands(pageBrowser,ready.siteUrl+'/run',790),[],'the Copy button never covers a command on the built Run page at 790px');}finally{await pageBrowser.close();}}
 const key=await readDevKey(f.root),gated={headers:{'x-rer-dev-key':key}};
 assert.equal(ready.signedInAs,'cli-owner@example.test','dev opens signed in as the owner setup claimed');
 assert.ok(!new URL(ready.openUrl).search,'the dev credential is never sent in a URL query');
 // Through a Host-rewriting local proxy every request looks local; without the
 // key each dev sign-in surface still answers 404, and the key is what admits.
 const proxy=await forwardingProxy(url);
 try{
  for(const path of ['/__dev/outbox','/auth/dev/enter?as=owner','/__dev/personas'])assert.equal((await fetch(proxy.url+path,{redirect:'manual'})).status,404,`${path} through the proxy`);
  assert.equal((await fetch(proxy.url+'/__dev/outbox',gated)).status,404,'captured mail is retired even with the key');
  // Nor do the runtime's Local Explorer (raw SQL on the store), its trigger
  // handlers, the key file itself or an export archive, directly or through the proxy.
  for(const path of ['/cdn-cgi/local/explorer/api/d1/database','/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*','/.rer/local/dev-key.env',`/@fs${f.root}/.rer/local/dev-key.env`,'/exports/journey.rer',`/@fs${f.root}/exports/journey.rer`,'/journey.rer','/package.json'])for(const origin of [url,proxy.url])assert.equal((await fetch(origin+path,{redirect:'manual'})).status,404,`${path} at ${origin}`);
 }finally{await proxy.close();await rm(join(f.root,'journey.rer'));}
 assert.ok(settings.equals(await readFile(join(f.root,'.dev.vars'))),'dev origin override never rewrites private settings');
 assert.equal((await fetch(url+'/health')).status,200);assert.equal((await fetch(url+'/@vite/client')).status,200,'real HMR asset server');
 assert.notEqual(await hostStatus(url+'/__dev/outbox','example.invalid'),200,'outbox is unavailable through a remote host');
 const livePath=join(f.root,kind==='default-seed'?'src/routes/reference.tsx':'src/branding.json'),originalSource=await readFile(livePath,'utf8'),marker='Live source update';
 await writeFile(livePath,kind==='default-seed'?originalSource.replace('Reference snapshot',marker):JSON.stringify({...JSON.parse(originalSource),name:marker}));
 try {let updated=false;for(let attempt=0;attempt<100&&!updated;attempt++){updated=(await (await fetch(url+(kind==='default-seed'?'/reference':'/'))).text()).includes(marker);if(!updated)await pause(100);}assert.ok(updated,'actual source update is served while dev remains running');}finally{await writeFile(livePath,originalSource);}
 await f.run(['reset','--yes','--non-interactive','--json'],4);
 await signedOutSetup(url);
 assert.equal(await hostStatus(url+'/setup','example.invalid'),421,'setup rejects a forged Host before revealing its document');
 const browser=await chromium.launch();
 try {
  // RER_OPEN opens the app signed in as the owner, at /setup until first-run is finished.
  const opened=await browser.newContext(),openedPage=await opened.newPage();
  await openedPage.goto(ready.openUrl);await openedPage.waitForURL(url+'/setup');
  assert.ok(!openedPage.url().includes('rer-dev'),'the key leaves the address bar');
  const devSession=await (await opened.request.get(url+'/auth/session')).json();
  assert.deepEqual([devSession.kind,devSession.operator.email],['dev','cli-owner@example.test']);
  await personaLinks({fixture:f,browser,context:opened,page:openedPage,origin:url,ownerLink:ready.openUrl});
  await opened.close();
  const context=await browser.newContext({javaScriptEnabled:false}),page=await context.newPage();
  // Local owner tooling exercises a real native session without capturing mail.
  const secret=localVariables(settings.toString()).SESSION_SECRET;
  const signed=await context.request.post(url+'/auth/local/cli-session',{headers:{Origin:url,'x-rer-local-cli':createHmac('sha256',secret).update('local-cli\0sign-in').digest('hex')},data:{returnTo:'/setup'},maxRedirects:0});
  assert.equal(signed.status(),303);await page.goto(url+'/setup');
  await ownerSetup(context,page,url);
  assert.deepEqual(await claimState(),{state:'claimed'},'the owner\'s confirmation claims the installation');
  assert.deepEqual(await lobbyLinks(),['/','/signin?login_hint=cli-owner%40example.test'],'the claimed Lobby offers only sign-in');
  const session=await context.request.get(url+'/auth/session');assert.equal(session.status(),200);const principal=await session.json();assert.equal(principal.operator.email,'cli-owner@example.test');
 } finally {await browser.close();}
 await f.stop(dev);assert.equal(dev.exitCode,143);assert.ok(await fetch(ready.siteUrl).then(()=>false,()=>true),'the run site preview stops with dev');assert.equal(events(dev).filter(e=>e.event==='ready').length,1);assert.equal(events(dev).at(-1).event,'result');
 const login=f.start(['dev','--login','--port',String(port),'--json','--non-interactive']);
 const loginDeadline=Date.now()+120000;while(!login.stdoutText.includes('"event":"ready"')&&login.exitCode===null&&Date.now()<loginDeadline)await pause(100);
 assert.ok(login.stdoutText.includes('"event":"ready"'),JSON.stringify({requirement:'legacy rer dev --login starts automatic owner entry',...commandDiagnostic(login)}));
 const loginReady=events(login).find(e=>e.event==='ready'),loginBrowser=await chromium.launch();
 try {
  const context=await loginBrowser.newContext(),page=await context.newPage();
  await page.goto(loginReady.openUrl);await page.waitForURL(url+'/app');
  const session=await (await context.request.get(url+'/auth/session')).json();assert.equal(session.kind,'dev');assert.equal(session.operator.email,'cli-owner@example.test');
 } finally {await loginBrowser.close();await f.stop(login);}
 const preview=f.start(['preview','--port',String(port),'--json','--non-interactive']);
 const previewDeadline=Date.now()+120000;while(!preview.stdoutText.includes('"event":"ready"')&&preview.exitCode===null&&Date.now()<previewDeadline)await pause(100);
 assert.ok(preview.stdoutText.includes('"event":"ready"'),'real preview starts');
 await privateRuntime(url,f.root,{kind,runtime:'preview'});await f.stop(preview);
 assert.deepEqual((await f.data('SELECT email FROM oa_first_run JOIN oa_operators ON completed_by = id'))[0].results,[{email:'cli-owner@example.test'}],'first-run completion persists in real D1 after app shutdown');
 assert.deepEqual((await f.data('SELECT value FROM cli_reset_probe'))[0].results,[{value:'prior owner content'}],'first-run completion preserves application data');
 const socket=createServer();await new Promise(resolve=>socket.listen(port,'127.0.0.1',resolve));
 try{await f.run(['dev','--port',String(port),'--non-interactive','--json'],4);}finally{await new Promise(resolve=>socket.close(resolve));}
 const retained=['src/reset-preserved.txt','node_modules/reset-preserved.txt','exports/reset-preserved.txt','deployment-receipts/reset-preserved.txt'];
 for(const path of retained){await mkdir(join(f.root,path,'..'),{recursive:true});await writeFile(join(f.root,path),'retained owner artifact');}
 await f.run(['reset','--non-interactive','--json'],4);await f.run(['reset','--yes','--non-interactive','--json']);await f.run(['reset','--yes','--non-interactive','--json']);
 for(const path of retained)assert.equal(await readFile(join(f.root,path),'utf8'),'retained owner artifact','reset preserves source/dependencies/exports/deployment receipts');
 await assert.rejects(access(join(f.root,'.dev.vars')));await assert.rejects(access(join(f.root,'.wrangler/state')));
 await writeFile(answers,JSON.stringify({...manifestAnswers,OWNER_EMAIL:'fresh-owner@example.test'}),{mode:0o600});
 url=events(await f.run(['setup','--answers','answers.json','--owner-email','fresh-owner@example.test','--non-interactive','--json'])).find(event=>event.event==='setup-ready').url;port=Number(new URL(url).port);await rm(answers);
 const tables=await f.data("SELECT name FROM sqlite_master WHERE name='cli_reset_probe'");assert.equal(tables[0].results.length,0,'confirmed reset removed prior domain rows');
 const ownerRows=await f.data('SELECT email FROM oa_operators');assert.deepEqual(ownerRows[0].results,[{email:'fresh-owner@example.test'}],'fresh setup has only the new real owner');
 const deploySettings=join(f.root,'.seed/installer/dry-run.env');await writeFile(deploySettings,'MAIL_API_KEY=test-only-outbound-key\n',{mode:0o600});
 const dry=await f.run(['deploy','--dry-run','--env-file','.seed/installer/dry-run.env','--json'],3);await rm(deploySettings);assert.equal(events(dry).at(-1).ok,false);assert.match(events(dry).find(event=>event.event==='error').message,/cannot read the target secret bindings/);
 // The run site builds from edition identity alone, even in a set-up checkout.
 const site=events(await f.run(['build','--site','--json'])).at(-1).site,siteRoot=join(f.root,site.path);
 const siteFiles=(await readdir(siteRoot,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name));
 assert.ok(siteFiles.some(file=>file===join(siteRoot,'index.html'))&&siteFiles.some(file=>file===join(siteRoot,'run.html')),'the run site has its homepage and Run page');
 const privateSettings=Object.values(Object.fromEntries((await readFile(join(f.root,'.dev.vars'),'utf8')).split('\n').filter(line=>/^(OWNER_EMAIL|SESSION_SECRET|SETUP_TOKEN)=/.test(line)).map(line=>line.split(/=(.*)/s)))).map(value=>value.replace(/^"|"$/g,''));
 for(const file of siteFiles){const bytes=await readFile(file);for(const value of privateSettings)assert.ok(!bytes.includes(value),`${file} carries no owner data or secret`);}
 const siteDry=events(await f.run(['deploy','--site','--dry-run','--json'])).at(-1);
 assert.deepEqual([siteDry.dryRun,siteDry.deployed,siteDry.site.bindings],[true,false,['ASSETS']]);assert.notEqual(siteDry.site.worker,siteDry.site.appWorker);
 assert.deepEqual(siteDry.site.redirects.map(rule=>rule.from),[`https://www.${siteDry.site.domain}/*`]);
 const stopped=await fetch(url+'/health').then(()=>false,()=>true);assert.ok(stopped,'bounded setup leaves no listener');
 const table=kind==='default-seed'?'articles':'notes';
 await f.data(kind==='default-seed'?"INSERT INTO articles VALUES('archive-row','archive-row','Saved title','Unicode café / two lines', '2026-10-09')":"INSERT INTO notes VALUES('archive-row','Unicode café / two lines',X'00FF10')");
 const beforeRows=(await f.data(`SELECT * FROM ${table} WHERE id='archive-row'`))[0].results;
 const originalIdentity=await originalArchiveIdentity(f,url);
 await f.data(`INSERT INTO oa_external_identities(issuer,subject,operator_id) SELECT 'https://identity.example.test','archive-subject',id FROM oa_operators WHERE email='fresh-owner@example.test';
  INSERT INTO oa_provider_sessions(session_id,issuer,subject,sid,generation) VALUES('archive-provider-session','https://identity.example.test','archive-subject','archive-sid',0);`);
 const liveCredentials=await f.data('SELECT count(*) n FROM oa_sessions; SELECT count(*) n FROM rer_dependency_keys; SELECT count(*) n FROM oa_provider_sessions');
 for(const result of liveCredentials)assert.ok(result.results[0].n>0,'source credentials exist before export filtering');
 const identityTables=['oa_operators','oa_bootstrap','oa_external_identities','rer_dependency_installation'];
 const retainedIdentityTables=kind==='foundation'?identityTables:['rer_dependency_installation'];
 const identityData=await f.data(identityTables.map(name=>`SELECT * FROM ${name}`).join(';'));
 const identityBefore=Object.fromEntries(identityTables.map((name,index)=>[name,identityData[index].results]));
 assert.equal(identityBefore.rer_dependency_installation[0].sector_id,originalIdentity.sector,'archive source retains the public installation sector');
 const first=events(await f.run(['export','--output','exports/first.rer','--json'])).at(-1);
 assert.equal((await stat(join(f.root,'exports/first.rer'))).mode&0o777,0o600);
 assert.ok(first.tables.some(entry=>entry.name===table&&entry.count>0),'archive contains real domain data');
 const firstArchive=archiveRecords(await readFile(join(f.root,'exports/first.rer'),'utf8'));
 for(const name of identityTables)assert.deepEqual(archiveRows(firstArchive,name),retainedIdentityTables.includes(name)?identityBefore[name]:[],`${name} follows the seed's archive identity policy`);
 for(const name of ['oa_sessions','oa_provider_sessions','rer_dependency_keys'])assert.deepEqual(archiveRows(firstArchive,name),[],`${name} does not travel`);
 await f.run(['export','--output','exports/first.rer','--json'],4);
 // The hosted install cannot be exported yet: a remote export is refused before any effect and saves nothing.
 await f.run(['export','--target','remote','--output','exports/remote.rer','--json'],2);
 await assert.rejects(stat(join(f.root,'exports/remote.rer')),{code:'ENOENT'});
 await f.run(['import','--input','exports/first.rer','--json'],4);
 await f.run(['import','--input','exports/first.rer','--yes','--json'],4);
 assert.deepEqual((await f.data(`SELECT * FROM ${table} WHERE id='archive-row'`))[0].results,beforeRows,'nonempty refusal leaves rows untouched');
 const archive=await readFile(join(f.root,'exports/first.rer'),'utf8');
 const lines=archive.trim().split('\n'),closing=JSON.parse(lines.at(-1));closing.contentHash='0'.repeat(64);lines[lines.length-1]=JSON.stringify(closing);
 await writeFile(join(f.root,'exports/corrupt.rer'),lines.join('\n')+'\n',{mode:0o600});
 await f.run(['reset','--yes','--json']);
 await f.run(['import','--input','exports/corrupt.rer','--yes','--json'],1);
 await assert.rejects(access(join(f.root,'.wrangler/state')),{code:'ENOENT'},'invalid archive never opens destination data bindings');
 const restored=events(await f.run(['import','--input','exports/first.rer','--yes','--json'])).at(-1);
 const second=events(await f.run(['export','--output','exports/second.rer','--json'])).at(-1);
 assert.equal(restored.contentHash,first.contentHash);
 const secondArchive=archiveRecords(await readFile(join(f.root,'exports/second.rer'),'utf8'));
 const expectedSecond=await remakeArchive(firstArchive,{items:archiveItems(firstArchive).map(item=>item.table==='oa_auth_settings'?{...item,row:{...item.row,generation:item.row.generation+1}}:item)});
 assert.deepEqual(archiveItems(secondArchive),archiveItems(expectedSecond),'re-export changes only the provider authority generation');
 assert.equal(second.contentHash,expectedSecond.at(-1).contentHash);
 assert.deepEqual(second.tables,first.tables);assert.equal(second.objects,first.objects);assert.equal(second.payloads,first.payloads);
 assert.deepEqual((await f.data(`SELECT * FROM ${table} WHERE id='archive-row'`))[0].results,beforeRows,'real rows survive reset and atomic restore');
 await assert.rejects(access(join(f.root,'.dev.vars')),'archives do not restore private settings');
 for(const name of identityTables)assert.deepEqual((await f.data(`SELECT * FROM ${name}`))[0].results,retainedIdentityTables.includes(name)?identityBefore[name]:[],`${name} follows the seed's atomic restore identity policy`);
 for(const name of ['oa_sessions','oa_provider_sessions','rer_dependency_keys'])assert.equal((await f.data(`SELECT count(*) n FROM ${name}`))[0].results[0].n,0,`${name} remains absent after restore`);
 assert.deepEqual((await f.data('SELECT idp_sign_in,first_setup FROM oa_auth_settings'))[0].results,kind==='foundation'?[{idp_sign_in:0,first_setup:0}]:[],'restore does not enable provider admission');
 await writeFile(answers,JSON.stringify({...manifestAnswers,OWNER_EMAIL:'fresh-owner@example.test'}),{mode:0o600});
 url=events(await f.run(['setup','--answers','answers.json','--owner-email','fresh-owner@example.test','--non-interactive','--json'])).find(event=>event.event==='setup-ready').url;port=Number(new URL(url).port);await rm(answers);
 await recoverArchiveIdentity(f,url,originalIdentity,{retained:kind==='foundation'});
 // Recovery signs the owner in, and each sign-in advances oa_operators.last_signin_at (durable sign-in history); every other column survives exactly.
 const signedIn=rows=>rows.map(({last_signin_at,...row})=>row);
 for(const name of retainedIdentityTables){
  const after=(await f.data(`SELECT * FROM ${name}`))[0].results;
  if(name!=='oa_operators'){assert.deepEqual(after,identityBefore[name],`${name} survives setup and native recovery exactly`);continue;}
  assert.deepEqual(signedIn(after),signedIn(identityBefore[name]),`${name} survives setup and native recovery exactly`);
  after.forEach((row,index)=>assert.ok(row.last_signin_at>=identityBefore[name][index].last_signin_at,'recovery sign-in only advances last_signin_at'));
 }
 if(kind==='default-seed'){
  assert.deepEqual((await f.data('SELECT email,role,status FROM oa_operators'))[0].results,[{email:'fresh-owner@example.test',role:'owner',status:'active'}],'a restored default-seed has one freshly claimed owner');
  assert.equal((await f.data('SELECT count(*) n FROM oa_bootstrap'))[0].results[0].n,1,'the fresh owner claim remains one-time');
  assert.deepEqual((await f.data('SELECT * FROM oa_external_identities'))[0].results,[],'provider identities require an explicit re-link');
 }
 await f.data(`UPDATE ${table} SET ${kind==='default-seed'?'title':'body'}='Updated after native recovery' WHERE id='archive-row'`);
 assert.equal((await f.data(`SELECT ${kind==='default-seed'?'title':'body'} AS value FROM ${table} WHERE id='archive-row'`))[0].results[0].value,'Updated after native recovery','restored application data remains writable');
 });
 // Successful full application verification already runs in verify:reference
 // and foundation/verify-export.mjs. Keep the CLI's real failure propagation.
 await t.test('application verification reports invalid source', async()=>{const path=join(f.root,'src/server.ts'),bytes=await readFile(path);try{await writeFile(path,'invalid application TypeScript {{{');const failed=await f.run(['verify','--json'],1);const rows=failed.stdoutText.trim().split('\n').map(JSON.parse),failure=rows.find(row=>row.event==='error');assert.match(failure.message,/Verifying application/);assert.match(failure.message,/error TS|ERROR|Error|Unexpected|Expected/);assert.ok(Number.isInteger(rows.at(-1).childExitCode),'actual child exit reaches the public result');}finally{await writeFile(path,bytes);}});
 await t.test('required first-party structural gate', async()=>{
 const events=child=>child.stdoutText.trim().split('\n').map(line=>JSON.parse(line));
 const check=await f.run(['check','--profile','first-party','--json']);assert.ok(events(check).at(-1).clauses.every(clause=>clause.ok),'the complete fresh structural contract passes');
 });
});
