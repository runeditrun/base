import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { loadState, saveState } from './state.mjs';
import { map, commands, pair, pairUsage } from './setup.mjs';
import { codexAuth, claudeAuth } from './auth.mjs';
import { assertSandboxPlatform } from './providers/sandbox.mjs';

export const usage = `Usage: rer companion VERB
Pairs this computer with a Run Edit Run app, then runs the app's change
requests here with your own Codex or Claude, in isolated checkouts. It makes
outbound HTTPS requests only and opens no local server. Needs Node 22 or later;
run needs macOS (sandbox-exec), and refuses on other systems.

  map PROJECT_ID OWNER/REPO CHECKOUT
                     Approve one local Git checkout for an app; its origin must be OWNER/REPO.
  ${pairUsage.replace('rer companion ', '')}
                     Redeem the one-use code from the app's Devices page. Asks for a
                     missing project or provider in a terminal (default provider codex).
                     The legacy form pair URL CODE PROJECT_ID [PROVIDER] [NAME] still works.
  codex-auth [AUTH_FILE]
                     Copy only Codex's auth.json into the dedicated executor home.
  claude-auth [--console]
                     Sign in to Claude with the dedicated executor home.
  commands PROJECT_ID FILE
                     Approve setup and verify argv lists, for example
                     {"setup":[["pnpm","install","--frozen-lockfile"]],"verify":[["pnpm","verify"]]}
  run [--once]       Take jobs from the app and run them; --once stops after one pass.
  status             The paired device, mapped projects, active job and pending events.
  confirm-no-turn-started JOB_ID --confirm-no-provider-turn-started
  confirm-unstarted JOB_ID --confirm-no-executor-started
                     Attest a setup failure that happened before any provider turn.

State: ~/.rer-local (RER_LOCAL_HOME picks another private folder). The device key
is kept there (0600); the app keeps only its hash.
Revoke: in the app, Settings > Devices > Revoke. A running companion stops at its
next request. Then delete the state folder on this computer.
`;

async function locked(root,work) {
  const lockPath=join(root,'runner.lock');let lock;
  try {lock=await open(lockPath,'wx',0o600);}catch(error){throw new Error('A runner lock exists. Stop the other runner, or verify it is gone before removing runner.lock and reconciling the active job.');}
  try{await lock.writeFile(String(process.pid));await work();}finally{await lock.close();await unlink(lockPath);}
}

export async function companionCommand(argv) {
  const [command,...args]=argv;
  if(!command||['--help','-h','help'].includes(command)||argv.includes('--help')) { process.stdout.write(usage); return 0; }
  const root=resolve(process.env.RER_LOCAL_HOME||join(homedir(),'.rer-local'));
  try {
    const state=await loadState(root);
    if(command==='map') await map(root,state,args);
    else if(command==='commands') await commands(root,state,args);
    else if(command==='pair') await pair(root,state,args);
    else if(command==='codex-auth') await codexAuth(root,args);
    else if(command==='claude-auth') await claudeAuth(root,args);
    else if(command==='run') {
      if(!state.token) throw new Error('Pair this computer first.');
      assertSandboxPlatform();
      const { run }=await import('./runner.mjs');
      await locked(root,()=>run(root,state,{once:args.includes('--once')}));
    } else if(command==='confirm-unstarted') {
      const { confirmUnstarted }=await import('./recovery.mjs');
      await locked(root,async()=>{const fresh=await loadState(root);await confirmUnstarted(root,fresh,args[0],args.includes('--confirm-no-executor-started'));await saveState(root,fresh);console.log('Preparation failure attested. Start the companion and use the normal Resume or Cancel control; no job was started.');});
    } else if(command==='confirm-no-turn-started') {
      const { confirmNoTurnStarted }=await import('./recovery.mjs');
      await locked(root,async()=>{const fresh=await loadState(root);await confirmNoTurnStarted(root,fresh,args[0],args.includes('--confirm-no-provider-turn-started'));await saveState(root,fresh);console.log('No-turn setup failure attested; retained checkout and dependencies preserved. Start the companion and use normal UI Resume. No job was started.');});
    } else if(command==='status') {
      console.log(JSON.stringify({device:state.device,projects:Object.keys(state.mappings),active:state.active?{job:state.active.job.id,status:state.active.status,identity:state.active.identity}:null,pendingEvents:state.outbox.length},null,2));
    } else { process.stderr.write(usage); return 2; }
    return 0;
  } catch(error) {process.stderr.write(`${error.message}\n`);return 1;}
}
