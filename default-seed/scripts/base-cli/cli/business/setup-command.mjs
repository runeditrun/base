import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setupDemo } from './setup-demo.mjs';

// The platform command prints its receipt as JSON in both human and --json mode.
export async function setupCommand(args) {
 try { return await setup(args) ?? 0; }
 catch (error) {
  // Paths, cookies and peer bodies must never appear in diagnostics.
  const code=typeof error?.message==='string'&&/^[a-z0-9_]{1,100}$/.test(error.message)?error.message:'demo_setup_failed';
  process.stderr.write(JSON.stringify({code})+'\n');return 1;
 }
}

async function setup(args){
 const usage='Usage: rer business setup --origin URL --session-file FILE --confirm-demo [--hosting managed|assisted|self_host] [--wait-seconds 0..240] [--json]';
 if(args.some(arg => ['--help', '-h'].includes(arg))){process.stdout.write(usage+'\n');return;}
 const options={};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--json'&&!options.json){options.json=true;continue;}
  if(args[i]==='--confirm-demo'){options.confirm=true;continue;}
  if(!['--origin','--session-file','--hosting','--wait-seconds'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('demo_arguments_invalid');
  options[args[i]]=args[++i];
 }
 if(!options.confirm||!options['--origin']||!options['--session-file'])throw Error('demo_confirmation_and_session_file_required');
 const url=new URL(options['--origin']);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('demo_origin_invalid');
 const hosting=options['--hosting']??'managed',waitSeconds=Number(options['--wait-seconds']??240);
 if(!['managed','assisted','self_host'].includes(hosting)||!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>240)throw Error('demo_arguments_invalid');
 const handle=await open(options['--session-file'],constants.O_RDONLY|constants.O_NOFOLLOW);
 let cookie;
 try{
  const stat=await handle.stat();if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid()||stat.size>16384)throw Error('demo_session_file_must_be_private');
  cookie=(await handle.readFile('utf8')).trim();
 }finally{await handle.close();}
 if(!/^(?:__Host-)?rer_session=[^\s;]+$/.test(cookie))throw Error('demo_session_file_invalid');
 const session=cookie.slice(cookie.indexOf('=')+1);
 try {
  const receipt=await setupDemo({origin:url.origin,cookie,hosting,waitSeconds});
  const output=JSON.stringify(receipt,null,2)+'\n';
  if(output.includes(session))throw Error('demo_session_in_response');
  process.stdout.write(output);
  if(receipt.required_provisioned<Math.min(5,receipt.required_total)||receipt.seeds.some(row=>['failed','waiting for owner','provisioning'].includes(row.state)))return 1;
  return 0;
 } catch(error) {
  if(String(error?.message).includes(session))throw Error('demo_session_in_response');
  throw error;
 }
}
