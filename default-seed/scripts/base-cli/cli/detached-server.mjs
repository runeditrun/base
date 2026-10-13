import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { shared } from './shared.mjs';
import { ready } from './managed-server.mjs';
import { RerError } from './errors.mjs';

// The actual dispatcher owns the server, registry and shutdown. Only its
// lifetime changes: its parent follows private JSON events until readiness,
// then leaves that process serving. A failed/interrupted start stops its child.
export async function detachedServer(options, argv, out) {
 const {privateDirectory} = await shared('private-files.mjs');
 const directory = await privateDirectory(options.cwd,['.rer','local']);
 const log = join(directory,`${options.verb}-launch-${randomUUID()}.log`), handle = await open(log,'wx',0o600);
 const args = argv.filter(arg => !['--detach','--foreground','--json'].includes(arg));
 let child, exit, spawnError, keep = false;
 const stop = () => child?.kill('SIGTERM');
 for (const signal of ['SIGINT','SIGTERM']) process.once(signal,stop);
 try {
  child = spawn(process.execPath,[fileURLToPath(new URL('../bin/rer.mjs',import.meta.url)),...args,'--foreground','--json'], {cwd:options.cwd, env:process.env, detached:true, stdio:['ignore',handle.fd,handle.fd]});
  child.once('error',error => {spawnError=error;exit=1;});
  child.once('exit',(code,signal) => {exit=code ?? (signal ? 128 : 1);});
  await handle.close();
  let offset=0, pending='', failure;
  for (;;) {
   const bytes = await readFile(log), text = bytes.subarray(offset).toString('utf8'); offset=bytes.length;
   pending += text;
   const lines=pending.split('\n');pending=lines.pop();
   for (const line of lines) {
    let event; try { event=JSON.parse(line); } catch { continue; }
    if (event.event==='error') failure=event;
    if (event.event==='ready') {
     keep=true;child.unref();
     const dev = event.openUrl ? {openUrl:event.openUrl,identity:options.verb === 'dev' && !options.login,signedInAs:event.signedInAs,ownerLeft:options.verb === 'dev' && !options.login && event.signedInAs === null} : undefined;
     ready(out,event.url,dev,options.json,Boolean(event.signInUrl),event.siteUrl);
     return 0;
    }
    if (event.event==='waiting' || event.event==='warning') out.event(event.event,event);
   }
   if (exit!==undefined) throw new RerError(failure?.code ?? 'command_failed',failure?.message ?? `The ${options.verb} server stopped before readiness (${spawnError?.code ?? exit}); inspect ${log}.`,failure?.exitCode ?? (exit || 1));
   await delay(200);
  }
 } finally {
  await handle.close().catch(() => {});
  for (const signal of ['SIGINT','SIGTERM']) process.off(signal,stop);
  if (!keep) stop();
 }
}
