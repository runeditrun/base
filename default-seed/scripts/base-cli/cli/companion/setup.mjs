import { realpath, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { saveState } from './state.mjs';
import { Api } from './api.mjs';
import { validateCommands } from './commands.mjs';
import { git } from './workspace.mjs';

export const pairUsage = 'rer companion pair URL CODE [--project PROJECT_ID] [--provider codex|claude] [--name NAME]';

// A project maps to one checkout whose origin is exactly the named repository.
async function mapProject(root,state,projectId,repository,path) {
  if(!projectId||!repository||!path) throw new Error('Usage: rer companion map PROJECT_ID OWNER/REPO CHECKOUT');
  const checkout=await realpath(path);const remote=await git(checkout,'remote','get-url','origin');
  if(![ `https://github.com/${repository}.git`,`https://github.com/${repository}`,`git@github.com:${repository}.git`].includes(remote)) throw new Error('Repository identity and checkout origin differ.');
  state.mappings[projectId]={repository,checkout,remote};await saveState(root,state);console.log(`Approved ${projectId}: ${repository} at ${checkout}`);
}

export function map(root,state,[projectId,repository,path]) { return mapProject(root,state,projectId,repository,path); }

export async function commands(root,state,[projectId,file]) {
  if(!state.mappings[projectId])throw new Error('Map project first.');
  state.mappings[projectId].commands=validateCommands(JSON.parse(await readFile(file,'utf8')));await saveState(root,state);console.log('Locally approved setup and verification argv saved. These commands have network access and no deployment credentials.');
}

// The pairing screen gives URL and CODE. Project and provider come from flags,
// the legacy positional form (URL CODE PROJECT_ID [PROVIDER] [NAME]), the only
// mapped project, or a terminal prompt.
function pairArguments(args) {
  const [server,code,...rest]=args,given={},positional=[];
  for(let index=0;index<rest.length;index++) {
    const flag=/^--(project|provider|name)$/.exec(rest[index]);
    if(!flag){if(rest[index].startsWith('--'))throw new Error(`Usage: ${pairUsage}`);positional.push(rest[index]);continue;}
    const value=rest[++index];
    if(value===undefined||value.startsWith('--')||Object.hasOwn(given,flag[1]))throw new Error(`Usage: ${pairUsage}`);
    given[flag[1]]=value;
  }
  if(!server||!code||positional.length>3)throw new Error(`Usage: ${pairUsage}`);
  const options={};
  for(const [index,key] of ['project','provider','name'].entries()) {
    if(positional[index]!==undefined&&given[key]!==undefined)throw new Error(`Usage: ${pairUsage}`);
    options[key]=given[key]??positional[index];
  }
  return {server,code,...options};
}

async function ask(terminal,question) { return (await terminal.question(question)).trim(); }

export async function pair(root,state,args) {
  const options=pairArguments(args);
  const interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY);
  const terminal=interactive?createInterface({input:process.stdin,output:process.stdout}):null;
  try {
    let projectId=options.project;const mapped=Object.keys(state.mappings);
    if(!projectId&&mapped.length===1)projectId=mapped[0];
    if(!projectId&&terminal)projectId=await ask(terminal,mapped.length?`Project ID (${mapped.join(', ')}): `:'Project ID (the app id in its Devices page command): ');
    if(!projectId)throw new Error(mapped.length?`Several projects are mapped. Run ${pairUsage} with --project.`:'Map the checkout locally before pairing: rer companion map PROJECT_ID OWNER/REPO CHECKOUT');
    if(!state.mappings[projectId]&&terminal) {
      console.log('Approve the local Git checkout this app may change.');
      await mapProject(root,state,projectId,await ask(terminal,'Repository (OWNER/REPO): '),await ask(terminal,'Checkout folder: '));
    }
    if(!state.mappings[projectId]) throw new Error('Map the checkout locally before pairing.');
    const provider=options.provider??(terminal?(await ask(terminal,'Provider, codex or claude [codex]: '))||'codex':'codex');
    const name=options.name??'Local engineering computer';
    if(!['codex','claude'].includes(provider)) throw new Error('Provider must be codex or claude.');
    const paired=await new Api(options.server).post('/api/local/pair',{code:options.code,name,provider,project_id:projectId});
    if(paired.repository!==state.mappings[projectId].repository) throw new Error('Paired installation repository differs from local mapping. Revoke this device.');
    Object.assign(state,{server:options.server,token:paired.token,device:paired.device,provider});await saveState(root,state);
    console.log(`Paired device ${paired.device.id} to ${paired.repository}. Selected requests and provider progress are relayed to RER; provider credentials stay here.`);
    console.log(`Next: rer companion ${provider}-auth, then rer companion run.`);
  } finally { terminal?.close(); }
}
