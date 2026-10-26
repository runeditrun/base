import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, rm, symlink, stat, statfs, access, readdir, readlink, mkdir, mkdtemp, truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {loadavg, freemem, tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture, pause} from './fixtures/reference.mjs';
import {processTree, remainingProcesses} from './fixtures/process-tree.mjs';
import {queuedCommands} from './fixtures/queued-commands.mjs';
import {serverResources} from './server-resources.mjs';
import {createHash} from 'node:crypto';

// Three seed-author journeys. Exercise the public dispatcher and real reference;
// deadlines bound a broken test, never assert operating-system scheduling speed.
let f, port, url, privateBytes, privateMode;
const cleanups = [];
before(async () => {
 f = await fixture('default-seed', {after: fn => cleanups.push(fn), diagnostic: () => {}});
 await f.run(['install', '--json']);
 const setup = events(await f.run(['setup', '--owner-email', 'managed-owner@example.test', '--non-interactive', '--json'])).find(row => row.event === 'setup-ready');
 assert.ok(setup);
 url = setup.url; port = Number(new URL(url).port);
 privateBytes = await readFile(join(f.root, '.dev.vars'));
 privateMode = (await stat(join(f.root, '.dev.vars'))).mode & 0o777;
 await f.data("CREATE TABLE managed_saved(value TEXT); INSERT INTO managed_saved VALUES('owner content')");
}, {timeout: 20 * 60_000});
after(async () => {for (const cleanup of cleanups.reverse()) await cleanup();});
const events = child => child.stdoutText.trim().split('\n').filter(Boolean).map(JSON.parse);
// Present the checkout key when probing local-only routes.
const gated = async () => ({headers: {'x-rer-dev-key': /^RER_DEV_KEY=(.+)$/m.exec(await readFile(join(f.root, '.rer/local/dev-key.env'), 'utf8'))[1]}});
async function ready(child, {root = f.root, origin = url} = {}) {
 const before = await startupResources(root);
 const deadline = Date.now() + 180000;
 while (!child.stdoutText.includes('"event":"ready"') && child.exitCode === null && Date.now() < deadline) await pause(100);
 if (!child.stdoutText.includes('"event":"ready"')) {
  if (child.exitCode !== null || child.signalCode !== null) await child.done;
  const rows = events(child), error = rows.find(row => row.event === 'error'), result = rows.find(row => row.event === 'result');
  const evidenceDirectory = process.env.RER_TEST_EVIDENCE_DIRECTORY;
  if (evidenceDirectory) {
   // Keep the CLI's already-redacted failure before teardown or another
   // command replaces its log. Ready events contain credentials: omit them.
   await mkdir(evidenceDirectory, {recursive: true});
   const evidence = await mkdtemp(join(evidenceDirectory, 'managed-ready-'));
   const log = await readFile(join(root, '.seed/installer/install.log'), 'utf8').catch(() => '');
   const messages = rows.filter(row => row.event === 'error').map(row => `${row.code}: ${row.message}`);
   await writeFile(join(evidence, 'failure.log'), [...messages, log].join('\n'), {mode: 0o600});
  }
  const codes = new Set(['safety_refusal', 'missing_input', 'command_failed', 'app_exited', 'cancelled']);
  // Print only fixed classifications and numbers, never private app output,
  // generated settings, sign-in messages, command arguments or log paths.
  const output = child.stdoutText + child.stderrText;
  const reasons = [
   ['load refusal', /this computer is busy\. Its 1-minute load/],
   ['disk refusal', /Server startup requires .* bytes free/],
   ['state custody refusal', /An active local operation owns the state\./],
   ['port collision', /EADDRINUSE|address already in use/],
   ['readiness deadline', /readiness deadline exceeded/],
   ['sign-in throttling', /HTTP 429 \(rate_limited\)/],
   ['runtime startup', /Starting your application/],
  ].filter(([, pattern]) => pattern.test(output)).map(([name]) => name);
  assert.fail('actual application health precedes ready: ' + JSON.stringify({
   exitCode: child.exitCode, signal: child.signalCode, errorCode: codes.has(error?.code) ? error.code : 'unclassified',
   resultExit: Number.isInteger(result?.exitCode) ? result.exitCode : null, reasons,
   resources: {before, after: await startupResources(root)},
  }));
 }
 assert.ok(events(child).some(row => row.event === 'ready'), 'actual application health precedes ready');
 const row = events(child).find(row => row.event === 'ready');
 assert.equal(row.url, origin); assert.equal(row.signInUrl, undefined);
 return child;
}
async function startupResources(root = f.root) {
 const available = await Promise.all([root, tmpdir()].map(async path => {const value = await statfs(path); return value.bavail * value.bsize;}));
 return {load: loadavg()[0], freeMemoryBytes: freemem(), availableBytes: available};
}
async function stopped(child, snapshot, origin = url) {
 assert.equal(await child.done, 0);
 assert.equal((await remainingProcesses(snapshot)).length, 0, 'every observed owned process lifetime ended, including reparented children');
 assert.equal(await fetch(origin + '/health').then(() => false, () => true), true, 'public listener is released');
}

// Observe the owned socket independently of the diagnostic implementation.
async function ownedListener(tree, port) {
 if (!tree.length) return;
 if (process.platform === 'linux') {
  const inodes = new Set();
  for (const name of ['tcp', 'tcp6']) for (const line of (await readFile('/proc/net/' + name, 'utf8')).trim().split('\n').slice(1)) {
   const fields = line.trim().split(/\s+/);
   if (fields[3] === '0A' && parseInt(fields[1].split(':')[1], 16) === port) inodes.add(fields[9]);
  }
  for (const owned of tree) for (const fd of await readdir(`/proc/${owned.pid}/fd`).catch(() => [])) {
   const socket = await readlink(`/proc/${owned.pid}/fd/${fd}`).catch(() => '');
   if (inodes.has(/^socket:\[(\d+)\]$/.exec(socket)?.[1])) return {...owned, port};
  }
  return;
 }
 const program = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
 let stdout;
 try { ({stdout} = await promisify(execFile)(program, ['-nP', '-a', '-p', tree.map(item => item.pid).join(','), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {timeout: 3000})); }
 catch (error) { if (error.code !== 1 || typeof error.stdout !== 'string') throw Error('Cannot inspect owned TCP listeners'); stdout = error.stdout; }
 const pids = new Set([...stdout.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1])));
 const owned = tree.find(item => pids.has(item.pid));
 return owned && {...owned, port};
}
async function healthStatus(origin) {
 try {
  const response = await fetch(origin + '/health', {signal: AbortSignal.timeout(3000)});
  if (!response.ok) {await response.body?.cancel(); return {status: response.status, healthy: false};}
  return {status: response.status, healthy: (await response.json()).status === 'ok'};
 } catch {return {healthy: false};}
}

test('rer dev shares one canonical checkout, returns its URL, and stops after idle', {timeout: 240000}, async () => {
 const occupied=createServer();
 await new Promise(resolve=>occupied.listen(port,'127.0.0.1',resolve));
 try {
  const refused=await f.run(['dev','--port',String(port),'--json'],4);
  assert.equal(events(refused).find(row=>row.event==='error').code,'safety_refusal');
  assert.ok(!events(refused).some(row=>row.event==='ready'));
  assert.deepEqual(JSON.parse(await readFile(join(f.registry,'state.json'),'utf8')).running,[],'occupied port releases the starting reservation');
  assert.equal(occupied.listening,true,'an occupied port leaves its existing owner alone');
 } finally {await new Promise(resolve=>occupied.close(resolve));}

 // This admission case owns its limit; the ordinary fixture's serving limit
 // leaves the other lifecycle assertions independent of shared host load.
 const overloaded=f.launch(['scripts/rer.mjs','dev','--json'],process.execPath,{RER_SERVERS_LOAD_THRESHOLD:'0'});
 assert.equal(await overloaded.done,4);
 assert.equal(events(overloaded).find(row=>row.event==='error').code,'safety_refusal');
 assert.ok(!events(overloaded).some(row=>row.event==='ready'));
 assert.deepEqual(JSON.parse(await readFile(join(f.registry,'state.json'),'utf8')).running,[],'load refusal releases the starting reservation');

 // Available memory below the floor refuses at once, naming the floor and its override.
 const starved=f.launch(['scripts/rer.mjs','dev','--json'],process.execPath,{RER_SERVERS_MIN_MEMORY_BYTES:String(2**50)});
 assert.equal(await starved.done,4);
 const refusal=events(starved).find(row=>row.event==='error');
 assert.equal(refusal.code,'safety_refusal');assert.match(refusal.message,/short of memory[^]*GiB is available[^]*RER_SERVERS_MIN_MEMORY_BYTES/);
 assert.ok(!events(starved).some(row=>row.event==='ready'));
 assert.deepEqual(JSON.parse(await readFile(join(f.registry,'state.json'),'utf8')).running,[],'memory refusal releases the starting reservation');

 // An invalid owner edit exercises real Vite startup failure and teardown.
 const config=join(f.root,'vite.config.ts'),configBytes=await readFile(config);
 const observed=new Map(),controls=new Set();let failed;
 try {
  await writeFile(config,'export default { invalid syntax\n');
  failed=f.start(['dev','--json']);
  const deadline=Date.now()+180000;
  while(failed.exitCode===null&&Date.now()<deadline){
   for(const item of await processTree(failed.pid))observed.set(`${item.pid}:${item.start}`,item);
   const registry=JSON.parse(await readFile(join(f.registry,'state.json'),'utf8'));
   for(const row of registry.running)controls.add(row.control);
   await pause(25);
  }
  assert.notEqual(failed.exitCode,null,'startup failure completes within the test deadline');
  assert.equal(await failed.done,1,'invalid real configuration fails startup');
 } finally {await writeFile(config,configBytes);if(failed)await f.stop(failed);}
 assert.ok(!events(failed).some(row=>row.event==='ready'));
 assert.ok(controls.size,'startup registered a control endpoint before failure');
 assert.equal((await remainingProcesses([...observed.values()])).length,0,'failed startup stops every observed owned lifetime');
 for(const control of controls)await assert.rejects(access(control),{code:'ENOENT'});
 assert.deepEqual(JSON.parse(await readFile(join(f.registry,'state.json'),'utf8')).running,[],'failed startup releases the registry reservation');
 assert.equal(await fetch(url+'/health').then(()=>false,()=>true),true,'failed startup releases the public port');
 assert.ok(privateBytes.equals(await readFile(join(f.root,'.dev.vars'))),'failed startup preserves private settings');
 assert.equal((await stat(join(f.root,'.dev.vars'))).mode&0o777,privateMode);
 assert.deepEqual((await f.data('SELECT value FROM managed_saved'))[0].results,[{value:'owner content'}],'failed startup retains canonical data and releases its state lock');

 const dev = await ready(f.launch(['--import', join(import.meta.dirname,'fixtures/slow-state-inspection.mjs'), 'scripts/rer.mjs', 'dev', '--port', String(port), '--json']));
 const original = await processTree(dev.pid);
 const alias = f.root + '-alias'; await symlink(f.root, alias);
 try {
  const duplicate = await f.run(['dev', '--cwd', alias, '--json']);
  assert.equal(events(duplicate).find(row => row.event === 'ready').url, url);
 } finally {await rm(alias);}
 const legacy=events(await f.run(['dev','--login','--json'])).find(row=>row.event==='ready');
 assert.equal(legacy.signedInAs,'managed-owner@example.test');
 assert.equal(legacy.signInUrl,undefined);
 const runtime = tree => tree.filter(row => row.executable === 'workerd').map(row => [row.pid,row.start]);
 assert.deepEqual(runtime(await processTree(dev.pid)), runtime(original), 'reuse keeps the actual runtime lifetime');
 assert.equal((await fetch(url + '/@vite/client')).status, 200, 'dev retains real Vite');
 await f.run(['dev', '--stop', '--json']);
 await stopped(dev, original);

 // Reuse/HMR gets the ordinary lifetime. A separate instance proves eventual
 // idle teardown without racing those assertions against a short timeout.
 const idle = await ready(f.start(['dev', '--idle-timeout', '5', '--json']));
 const idleLifetime = await processTree(idle.pid);
 await stopped(idle, idleLifetime);
 await f.run(['dev', '--stop', '--json']);
});

for (const mode of ['dev', 'preview']) test(`rer ${mode} runs the declared scheduled triggers on their schedule, reports each run, and stops them with ${mode}`, {timeout: 300000}, async () => {
 const config = join(f.root, 'wrangler.jsonc'), original = await readFile(config, 'utf8');
 const runs = async () => (await f.data('SELECT count(*) AS n FROM scheduled_runs'))[0].results[0].n;
 try {
  await writeFile(config, original.replace(/"crons": \[[^\]]*\]/, '"crons": ["* * * * *"]'));
  const before = await runs();
  const server = await ready(f.start([mode, '--port', String(port), '--json']));
  const lifetime = await processTree(server.pid);
  const deadline = Date.now() + 120000, scheduled = () => events(server).filter(row => row.event === 'scheduled');
  while (!scheduled().length && server.exitCode === null && Date.now() < deadline) await pause(250);
  assert.ok(scheduled().length, 'a run is reported within the minute');
  assert.deepEqual([scheduled()[0].cron, scheduled()[0].ok], ['* * * * *', true]);
  assert.ok(await runs() > before, 'the seed handler ran and wrote its row');
  await f.run([mode, '--stop', '--json']);
  await stopped(server, lifetime);
  const finished = scheduled().length;
  await pause(1500);
  assert.equal(scheduled().length, finished, `no run is reported after ${mode} stops`);
 } finally {await writeFile(config, original);}
});

test('server startup measures write paths, sizes the disk floor to the seed, and honours the override', async t => {
 const gib = 1024n ** 3n, root = await mkdtemp(join(tmpdir(), 'rer-disk-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 const temporary = join(root, 'temporary'), registry = join(root, 'servers');
 await Promise.all([temporary, registry, join(root, 'node_modules'), join(root, '.wrangler/state/v3/d1')].map(path => mkdir(path, {recursive: true})));
 const env = {TMPDIR: temporary, RER_SERVERS_DIR: registry}, seen = new Set();
 const admitted = (free = 4n * gib, extra = {}, volumes = new Map()) => serverResources(root, {env: {...env, ...extra}, disk: async path => {
  seen.add(path);
  // The OS default temp volume is small; the selected TMPDIR has room.
  return {bavail: volumes.get(path) ?? (path === tmpdir() ? 64n * 1024n ** 2n : free), bsize: 1n};
 }});
 await assert.doesNotReject(admitted(32n * gib));
 for (const path of [root, temporary, registry]) assert.ok(seen.has(path), `measured write path ${path}`);
 assert.ok(!seen.has(tmpdir()), 'an unused default temp filesystem cannot refuse startup');
 await assert.doesNotReject(admitted(), 'a small seed does not require a fixed large floor');
 let initialNeed;
 const shortage = path => error => {
  const needed = /requires (\d+) bytes free/.exec(error.message)?.[1];
  assert.equal(error.exitCode, 4);
  assert.ok(error.message.includes(path));
  assert.match(error.message, /0 bytes free/);
  assert.match(error.message, /RER_SERVERS_DISK_FLOOR_GIB/);
  assert.ok(BigInt(needed) > 0n);
  initialNeed ??= BigInt(needed);
  return true;
 };
 for (const path of [root, temporary, registry]) await assert.rejects(admitted(4n * gib, {}, new Map([[path, 0n]])), shortage(path));
 // Real measured dependency and D1 bytes increase the admission requirement.
 for (const path of [join(root, 'node_modules/dependency.bin'), join(root, '.wrangler/state/v3/d1/database.sqlite')]) {
  await writeFile(path, ''); await truncate(path, Number(gib));
 }
 await assert.rejects(admitted(), error => BigInt(/requires (\d+) bytes free/.exec(error.message)?.[1]) > initialNeed);
 await assert.doesNotReject(admitted(gib / 2n, {RER_SERVERS_DISK_FLOOR_GIB: '0.25'}));
 await assert.doesNotReject(admitted(0n, {RER_SERVERS_DISK_FLOOR_GIB: '0'}));
 await assert.rejects(admitted(3n * gib, {RER_SERVERS_DISK_FLOOR_GIB: '3.5'}), error => error.message.includes(`${7n * gib / 2n} bytes`));
 for (const value of ['', 'lots', '-1', '4GiB', '1e3']) await assert.rejects(admitted(100n * gib, {RER_SERVERS_DISK_FLOOR_GIB: value}), error => error.exitCode === 4 && error.message.includes('RER_SERVERS_DISK_FLOOR_GIB'), value);
 // Through the real command: an invalid value refuses before anything starts.
 const invalid = f.launch(['scripts/rer.mjs', 'dev', '--json'], process.execPath, {RER_SERVERS_DISK_FLOOR_GIB: 'lots'});
 assert.equal(await invalid.done, 4);
 assert.match(events(invalid).find(row => row.event === 'error').message, /RER_SERVERS_DISK_FLOOR_GIB/);
 assert.ok(!events(invalid).some(row => row.event === 'ready'));
});

test('rer dev caches font bytes without changing document or module policies', {timeout: 240000}, async () => {
 const path='/fonts/outfit/outfit-latin-wght-normal.woff2';
 const bytes=await readFile(join(f.root,'public',path));
 const hashed=`/fonts/brand-${createHash('sha256').update(bytes).digest('hex').slice(0,16)}.woff2`;
 await writeFile(join(f.root,'public',hashed),bytes);
 let child,processLifetime;
 try {
  child=await ready(f.start(['dev','--json']));
  processLifetime=await processTree(child.pid);
  const font=await fetch(url+path),versioned=await fetch(url+hashed);
  assert.equal(font.status,200);assert.equal(versioned.status,200);
  assert.ok(bytes.equals(Buffer.from(await font.arrayBuffer())),'actual font bytes survive the public proxy');
  const policy=font.headers.get('cache-control'),immutable=versioned.headers.get('cache-control');
  const lifetime=value=>Number(/max-age=(\d+)/.exec(value??'')?.[1]??0);
  assert.ok(lifetime(policy)>0&&!/no-cache|no-store/.test(policy),'source fonts remain fresh across page loads');
  assert.ok(lifetime(immutable)>lifetime(policy)&&/immutable/.test(immutable),'versioned fonts can be cached longer');
  const document=await fetch(url+'/'),module=await fetch(url+path+'?import'),session=await fetch(url+'/auth/session',await gated());
  assert.match(document.headers.get('cache-control'),/no-store/,'private document policy survives');
  assert.ok(!/immutable|max-age/.test(module.headers.get('cache-control')??''),'Vite font-import JavaScript keeps its policy');
  const validator=module.headers.get('etag');
  assert.ok(validator,'the real font-import module exposes its HTTP validator');
  const unchangedModule=await fetch(url+path+'?import',{headers:{'if-none-match':validator}});
  assert.equal(unchangedModule.status,304,'the public door serves a real conditional module response');
  assert.ok(!/immutable|max-age/.test(unchangedModule.headers.get('cache-control')??''),'conditional JavaScript font imports keep their policy too');
  assert.match(session.headers.get('cache-control'),/no-store/,'session response remains private');
  await Promise.all([versioned.arrayBuffer(),document.arrayBuffer(),module.arrayBuffer(),session.arrayBuffer()]);
 } finally {
  if(child){await f.run(['dev','--stop','--json']);if(processLifetime)await stopped(child,processLifetime);else await f.stop(child);}
  await rm(join(f.root,'public',hashed),{force:true});
 }
});

test('legacy rer dev --login opens automatically as owner without a mail route', {timeout: 300000}, async () => {
 const child = await ready(f.start(['dev', '--login', '--port', String(port), '--json']));
 try {
  const info = events(child).find(event => event.event === 'ready');
  assert.equal(info.signedInAs, 'managed-owner@example.test');
  assert.equal(new URLSearchParams(new URL(info.openUrl).hash.slice(1)).get('as'), 'owner');
  assert.equal(info.signInUrl, undefined);
  assert.equal((await fetch(url + '/__dev/outbox', await gated())).status, 404);
 } finally { await f.run(['dev', '--stop', '--json']); await f.stop(child); }
});

test('managed startup reports a real misbound application port and stops its descendants', {timeout: 300000}, async t => {
 const adapter=join(f.root,'scripts/installer/local.mjs'),original=await readFile(adapter,'utf8');
 // The runtime target picks the misbound port as rer picks its internal one: free,
 // never the assigned port, outside the OS ephemeral range. The app's own listen(0)
 // sockets (Miniflare starts before Vite binds) can then never take it first.
 const loopbackPorts=JSON.stringify(new URL('./runtime-front-door.mjs',import.meta.url).href);
 for(const mode of ['dev','preview']){
  const target=mode==='dev'?'developmentTarget':'previewTarget';
  const portsFile=join(f.root,`.rer-misbound-${mode}-ports.json`),partialPortsFile=portsFile+'.partial';
  const replacement=`${mode}: async context=>{const fs=await import('node:fs/promises'),wrongPort=await (await import(${loopbackPorts})).runtimeLoopbackPort(context.runtimePort);await fs.writeFile(${JSON.stringify(partialPortsFile)},JSON.stringify({assigned:context.runtimePort,wrong:wrongPort}),{mode:0o600});await fs.rename(${JSON.stringify(partialPortsFile)},${JSON.stringify(portsFile)});const target=${target}(context);${mode==='dev'?`target[1][target[1].indexOf('--port')+1]=String(wrongPort);`:`target[2].env.RER_RUNTIME_PORT=String(wrongPort);`}return target;}`;
  const observed=new Map(),controls=new Set();let child,ports,listener,expectedPort,wrongPort,healthyWrongPort=false,proxyFailed=false,primaryFailure;
  try{
   await writeFile(adapter,original.replace(`${mode}: ${target}`,replacement));
   child=f.start([mode,'--json']);
   const deadline=Date.now()+130000;
   while(child.exitCode===null&&Date.now()<deadline){
    const tree=await processTree(child.pid);
    for(const item of tree)observed.set(`${item.pid}:${item.start}`,item);
    const registry=await readFile(join(f.registry,'state.json'),'utf8').then(JSON.parse,error=>{
     if(error.code==='ENOENT')return {running:[]};
     throw error;
    });
    for(const row of registry.running)if(tree.some(item=>item.pid===row.owner.pid))controls.add(row.control);
    ports??=await readFile(portsFile,'utf8').then(JSON.parse,error=>{
     if(error.code==='ENOENT')return undefined;
     throw error;
    });
    if(ports)listener??=await ownedListener(tree,ports.wrong);
    if(listener&&!proxyFailed&&tree.some(item=>item.pid===listener.pid&&item.start===listener.start)){
     healthyWrongPort=(await healthStatus(`http://127.0.0.1:${ports.wrong}`)).healthy;
     if(healthyWrongPort)proxyFailed=(await healthStatus(url)).status===404;
    }
    await pause(250);
   }
   assert.notEqual(child.exitCode,null,'misbound real application cannot wait indefinitely');
   assert.equal(await child.done,1);
   ({assigned:expectedPort,wrong:wrongPort}=JSON.parse(await readFile(portsFile,'utf8')));
   const failure=events(child).find(event=>event.event==='error');
   assert.ok(listener&&Number.isInteger(listener.pid),'an owned process really listened on the misbound port');
   assert.ok(healthyWrongPort,'the real application was healthy on the misbound listener');
   assert.ok(proxyFailed,'the public proxy could not reach the assigned internal listener');
   assert.ok(Number.isInteger(expectedPort)&&expectedPort>0&&expectedPort<=65535,'the real adapter context records the assigned internal port');
   assert.notEqual(expectedPort,wrongPort);
   const portPatterns=[listener.port,expectedPort].map(value=>new RegExp(`(?<!\\d)${value}(?!\\d)`));
   for(const pattern of portPatterns)assert.match(failure.message,pattern,'the final diagnostic retains both observed and assigned ports');
   assert.ok(failure.message.split('\n').some(line=>portPatterns.every(pattern=>pattern.test(line))),'one composed diagnostic line relates the observed listener to the assigned port');
   assert.ok(!events(child).some(event=>event.event==='ready'));
   assert.equal((await remainingProcesses([...observed.values()])).length,0,'all observed owned descendants stopped');
   assert.ok(controls.size,'misbound startup registered its lifecycle control');
   for(const control of controls)await assert.rejects(access(control),{code:'ENOENT'});
   assert.deepEqual(JSON.parse(await readFile(join(f.registry,'state.json'),'utf8')).running,[],'misbound startup releases its registry reservation');
   assert.equal(await fetch(`http://127.0.0.1:${wrongPort}/health`).then(()=>false,()=>true),true,'misbound listener stopped');
   assert.equal(await fetch(url+'/health').then(()=>false,()=>true),true,'public listener stopped');
   assert.ok(privateBytes.equals(await readFile(join(f.root,'.dev.vars'))),'private settings preserved');
   assert.equal((await stat(join(f.root,'.dev.vars'))).mode&0o777,privateMode);
  }catch(error){
   primaryFailure=error;throw error;
  }finally{
   try{await writeFile(adapter,original);}
   finally{try{if(child)try{await f.stop(child);}catch(error){if(!primaryFailure)throw error;t.diagnostic('Owned teardown also failed after the reported startup failure');}}finally{await rm(portsFile,{force:true});await rm(partialPortsFile,{force:true});}}
  }
 }
});

test('rer preview serves one fixed production workerd at the saved origin and keeps canonical local data', {timeout: 300000}, async () => {
 const sourceAsset = join(f.root,'public/preview-change.txt');
 await writeFile(sourceAsset,'original preview asset');
 const child = await ready(f.start(['preview', '--json']));
 const topology = await processTree(child.pid);
 assert.equal(topology.filter(row => row.executable === 'workerd').length, 1);
 assert.equal(topology.some(row => row.vite), false);
 // Secrets reach the resident runtime through a pipe, never an argument, and the
 // Wrangler converter that reads them runs only in a short-lived child.
 const argv = (await promisify(execFile)('/bin/ps', ['-ww', '-o', 'command=', '-p', topology.map(row => row.pid).join(',')])).stdout;
 const secrets = [...privateBytes.toString().matchAll(/^[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*=(.{12,})$/gm)].map(match => match[1].replace(/^['"]|['"]$/g, '')).concat((await gated()).headers['x-rer-dev-key']);
 assert.ok(secrets.length >= 2);
 for (const value of secrets) assert.ok(!argv.includes(value), 'a secret value reached a process argument');
 assert.ok(!argv.includes('wrangler'), 'Wrangler stays out of the resident preview process tree');
 assert.notEqual((await fetch(url + '/@vite/client')).status, 200);
 assert.equal((await fetch(url + '/health')).status, 200);
 const asset = await fetch(url + '/preview-change.txt'), validator = asset.headers.get('etag');
 assert.equal(await asset.text(),'original preview asset');
 await writeFile(join(f.root,'dist/client/preview-change.txt'),'changed preview asset');
 let refreshed;
 const deadline = Date.now() + 30000;
 while (Date.now() < deadline) {
  const reply = await fetch(url + '/preview-change.txt',{headers:{'if-none-match':validator}});
  refreshed = {status:reply.status,etag:reply.headers.get('etag'),text:await reply.text()};
  if (refreshed.status === 200 && refreshed.text === 'changed preview asset') break;
  await pause(100);
 }
 assert.equal(refreshed.status,200,'an old validator cannot hide changed assets');
 assert.equal(refreshed.text,'changed preview asset');
 assert.notEqual(refreshed.etag,validator);
 const duplicate = await f.run(['preview', '--json']);
 assert.equal(events(duplicate).find(row => row.event === 'ready').url, url);
 assert.equal(events(duplicate).find(row=>row.event==='ready').signInUrl,undefined);
 await f.run(['dev', '--json'], 4);
 await f.run(['reset', '--yes', '--json'], 4);
 const source = join(f.root, 'src/routes/reference.tsx'), saved = await readFile(source, 'utf8');
 await writeFile(source, saved.replace('Reference snapshot', 'Unbuilt owner edit'));
 try {assert.ok(!(await (await fetch(url + '/reference')).text()).includes('Unbuilt owner edit'), 'preview keeps fixed production output');}
 finally {await writeFile(source, saved);}
 assert.ok(privateBytes.equals(await readFile(join(f.root, '.dev.vars'))), 'private bytes stay intact');
 assert.equal((await stat(join(f.root, '.dev.vars'))).mode & 0o777, privateMode);
 await f.run(['preview', '--stop', '--json']); await stopped(child, topology);
 assert.deepEqual((await f.data('SELECT value FROM managed_saved'))[0].results, [{value: 'owner content'}]);
 const detached = await f.run(['preview','--detach','--json']);
 assert.equal(events(detached).find(row => row.event === 'ready').url,url);
 assert.equal((await fetch(url + '/health')).status,200,'preview keeps serving after the starting command exits');
 await f.run(['preview','--stop','--json']);
 await assert.rejects(fetch(url + '/health'));
 await rm(sourceAsset);
});

test('rer preview refuses build-time rewrites by name until the project declares its generated outputs', {timeout: 15 * 60_000}, async t => {
 // This independent build flow owns its installation and ordinary sign-in
 // budget; the earlier owner journey must keep the real auth policy intact.
 const project = await fixture('default-seed', t);
 await project.run(['install', '--json']);
 const setup = events(await project.run(['setup', '--owner-email', 'generated-owner@example.test', '--non-interactive', '--json'])).find(row => row.event === 'setup-ready');
 assert.ok(setup);
 const origin = setup.url;
 // The build itself (Vite loading its config) rewrites one generated file and,
 // in the second half, edits one real source. Both reach preview as owner would.
 const config = join(project.root, 'vite.config.ts'), adapter = join(project.root, 'scripts/installer/local.mjs');
 const generated = join(project.root, 'generated-output.txt'), source = join(project.root, 'src/routes/reference.tsx');
 const configBytes = await readFile(config), adapterBytes = await readFile(adapter, 'utf8'), sourceBytes = await readFile(source);
 // Vite evaluates its config when the build starts; the prefix runs inside the build.
 const duringBuild = (target, text) => `import {writeFileSync as buildWrite} from 'node:fs';buildWrite(${JSON.stringify(target)},${JSON.stringify(text)});\n`;
 const failure = child => events(child).find(row => row.event === 'error');
 try {
  await writeFile(generated, 'generated\n');
  await writeFile(config, duringBuild(generated, 'generated\n') + configBytes);
  const refused = await project.run(['preview', '--json'], 4);
  assert.equal(failure(refused).code, 'safety_refusal');
  assert.match(failure(refused).message, /generated-output\.txt/, 'the refusal names the rewritten file');
  assert.match(failure(refused).message, /generatedOutputs/, 'the refusal says how to declare it');
  assert.equal(events(refused).filter(row => row.event === 'error').length, 1, 'the command emits one refusal');
  assert.ok(!events(refused).some(row => row.event === 'ready'));

  await writeFile(adapter, adapterBytes.replace('product: model.product.name,', "generatedOutputs: ['generated-output.txt'], product: model.product.name,"));
  const child = await ready(project.start(['preview', '--json']), {root: project.root, origin});
  const topology = await processTree(child.pid);
  assert.equal((await fetch(origin + '/reference')).status, 200, 'declared rewrites do not stop preview serving the app');
  await project.run(['preview', '--stop', '--json']); await stopped(child, topology, origin);

  await writeFile(config, duringBuild(source, sourceBytes + '\n// edited during the build\n') + configBytes);
  const edited = await project.run(['preview', '--json'], 4);
  assert.match(failure(edited).message, /src\/routes\/reference\.tsx/, 'a real source edited during the build is still refused, named');
  assert.ok(!events(edited).some(row => row.event === 'ready'));
 } finally {
  await writeFile(config, configBytes); await writeFile(adapter, adapterBytes); await writeFile(source, sourceBytes); await rm(generated, {force: true});
 }
});

test('a checkout without a declared run site refuses rer build --site before any effect', {timeout: 120000}, async () => {
 const adapter = join(f.root, 'scripts/installer/local.mjs'), adapterBytes = await readFile(adapter, 'utf8');
 const listing = async () => [await readdir(f.root), await readdir(join(f.root, 'dist')).catch(() => [])];
 await writeFile(adapter, adapterBytes.replace(/^ site: \{[^\n]*\},\n/m, ''));
 try {
  assert.notEqual(await readFile(adapter, 'utf8'), adapterBytes, 'the fixture declares no run site');
  const before = await listing();
  const refused = await f.run(['build', '--site', '--json'], 4);
  assert.equal(events(refused).find(row => row.event === 'error').code, 'safety_refusal');
  assert.deepEqual(await listing(), before, 'the refusal changes nothing in the checkout');
 } finally { await writeFile(adapter, adapterBytes); }
});

test('a run site renders with the seed\'s own site plugins and links the CSS its pages import', {timeout: 120000}, async () => {
 // A seed's approved page imports its stylesheets and its docs come from a Vite
 // plugin's virtual module; the site build loads that plugin and ships the CSS.
 const adapter = join(f.root, 'scripts/installer/local.mjs'), adapterBytes = await readFile(adapter, 'utf8');
 const created = ['vite.site.config.ts', 'src/site/styled.ts', 'src/site/styled.css', 'src/site/styled-dot.svg'].map(path => join(f.root, path));
 await writeFile(created[0], "export default { plugins: [{ name: 'site-note', resolveId: (id: string) => id === 'virtual:site-note' ? '\\0site-note' : undefined, load: (id: string) => id === '\\0site-note' ? 'export const note = \"plugin-rendered\"' : undefined }] }\n");
 await writeFile(created[1], "import './styled.css'\nimport { note } from 'virtual:site-note'\nimport { sitePages as plain } from './pages'\nexport function sitePages({ styles }: { styles: string[] }) {\n  const build = plain()\n  return { ...build, pages: build.pages.map(page => ({ ...page, html: page.html.replace('</head>', styles.map(href => `<link rel=\"stylesheet\" href=\"${href}\">`).join('') + '</head>').replace('</main>', `<p class=\"styled-probe\">${note}</p></main>`) })) }\n}\n");
 await writeFile(created[2], '.styled-probe { background: url(./styled-dot.svg) no-repeat; }\n');
 // Past Vite's inline limit, so it ships as its own file.
 await writeFile(created[3], `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!-- ${'.'.repeat(8192)} --><rect width="1" height="1"/></svg>\n`);
 await writeFile(adapter, adapterBytes.replace("site: { entry: 'src/site/pages.ts',", "site: { config: 'vite.site.config.ts', entry: 'src/site/styled.ts',"));
 try {
  assert.notEqual(await readFile(adapter, 'utf8'), adapterBytes, 'the fixture names a site config and a styled entry');
  const site = events(await f.run(['build', '--site', '--json'])).at(-1).site, siteRoot = join(f.root, site.path);
  const home = await readFile(join(siteRoot, 'index.html'), 'utf8');
  assert.match(home, /<p class="styled-probe">plugin-rendered<\/p>/, 'the site config\'s plugin module renders into the page');
  const sheets = [...home.matchAll(/<link rel="stylesheet" href="(\/site-assets\/[^"]+\.css)">/g)].map(match => match[1]);
  assert.equal(sheets.length, 1, 'the page links the compiled stylesheet');
  const css = await readFile(join(siteRoot, sheets[0]), 'utf8'), dot = /url\("?([^")]+)"?\)/.exec(css)?.[1];
  assert.match(css, /\.styled-probe/, 'the imported CSS is in the site');
  assert.ok(dot && await access(join(siteRoot, dot)).then(() => true, () => false), 'a file the CSS references ships with it');
  assert.ok(!(await readdir(join(siteRoot, 'site-assets'))).some(name => name.endsWith('.js')), 'no Node bundle reaches the site');
 } finally {
  await writeFile(adapter, adapterBytes);
  for (const path of created) await rm(path, {force: true});
 }
});

test('owner identifiers refuse the run site without stopping a healthy dev app', {timeout: 180000}, async () => {
 const entry = join(f.root, 'src/site/pages.ts'), original = await readFile(entry, 'utf8');
 const answers = join(f.root, '.seed/installer/setup-answers.json');
 const previous = await readFile(answers, 'utf8').catch(() => undefined);
 // A short name must be protected too; its occurrence inside another word is
 // still public example text, as is an email belonging to a different mailbox.
 await writeFile(answers, JSON.stringify({OWNER_EMAIL: 'managed-owner@example.test', displayName: 'Jo'}), {mode: 0o600});
 const render = text => writeFile(entry, original.replace('html: siteHomeHtml(identity, run, contract)', `html: siteHomeHtml(identity, run, contract).replace('</main>', ${JSON.stringify('<p>' + text + '</p></main>')})`));
 let dev;
 try {
  await render('Joins: co-managed-owner@example.test and managed-owner@example.test.invalid');
  await f.run(['build', '--site', '--json']);
  for (const identity of ['Jo', 'MANAGED-OWNER@EXAMPLE.TEST.']) {
   await render(identity);
   const refused = events(await f.run(['build', '--site', '--json'], 4));
   assert.ok(refused.some(event => event.event === 'error' && event.code === 'site_private_data'));
  }
  const secret = /^SESSION_SECRET=(.+)$/m.exec(privateBytes.toString('utf8'))?.[1];
  assert.ok(secret, 'setup saved a real generated secret');
  await render('prefix' + secret + 'suffix');
  await f.run(['build', '--site', '--json'], 4);
  await render('managed-owner@example.test');
  dev = f.start(['dev', '--port', String(port), '--json']);
  await ready(dev);
  const info = events(dev).find(event => event.event === 'ready');
  assert.equal(info.siteUrl, undefined, 'refused site output has no preview');
  assert.ok(events(dev).some(event => event.event === 'warning' && event.code === 'site_private_data'));
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal(dev.exitCode, null, 'the managed app retains its foreground lifetime');
  await f.run(['dev', '--stop', '--json']);
  assert.equal(await dev.done, 0);
 } finally {
  if (dev) await f.stop(dev);
  await writeFile(entry, original);
  if (previous === undefined) await rm(answers, {force: true}); else await writeFile(answers, previous);
 }
});

test('rer heavy verbs enter the actual queue and nested commands share admission', {timeout: 22 * 60_000}, queuedCommands);
