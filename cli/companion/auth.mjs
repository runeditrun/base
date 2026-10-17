import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function configuredCodexAuthPath() {
  const configured=process.env.CODEX_HOME;
  if(configured!==undefined&&!isAbsolute(configured)) throw new Error('CODEX_HOME must be an absolute path.');
  return join(resolve(configured||join(homedir(),'.codex')),'auth.json');
}

// Only the chosen authentication file enters the dedicated executor home;
// Codex configuration and MCP servers are never imported.
export async function codexAuth(root,args) {
  const source=resolve(args[0]||configuredCodexAuthPath());const dir=join(root,'executor-home','.codex');await mkdir(dir,{recursive:true,mode:0o700});await copyFile(source,join(dir,'auth.json'));await chmod(join(dir,'auth.json'),0o600);console.log('Copied Codex authentication into the dedicated executor home. Configuration and MCP servers were not imported.');
}

export async function claudeAuth(root,args) {
  const dir=join(root,'executor-home');await mkdir(dir,{recursive:true,mode:0o700});
  // Login runs with only the dedicated HOME and harmless process settings.
  // Host Claude config, MCP/project history, API keys and gateway credentials
  // are never inherited into the supported OAuth flow.
  const env={PATH:process.env.PATH||'',HOME:dir,TMPDIR:process.env.TMPDIR||'/tmp',LANG:process.env.LANG||'en_US.UTF-8'};
  const loginMode=args.some(value=>value==='--console'||value==='--claudeai')?[]:['--claudeai'];
  const login=spawnSync('claude',['auth','login',...loginMode,...args],{stdio:'inherit',env});
  if(login.error) throw login.error;
  if(login.status!==0) throw new Error(`Claude subscription login exited with status ${login.status??'unknown'}.`);
  const status=spawnSync('claude',['auth','status','--json'],{encoding:'utf8',env});
  if(status.error) throw status.error;
  if(status.status!==0) throw new Error('Claude subscription login did not produce a usable dedicated authentication state.');
  let authenticated=false;try{authenticated=Boolean(JSON.parse(status.stdout).loggedIn)}catch{}
  if(!authenticated) throw new Error('Claude subscription login did not produce a usable dedicated authentication state.');
  console.log('Claude subscription authentication verified in the dedicated executor home.');
}
