import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

const company = JSON.parse(await readFile(new URL('./setup-company.json', import.meta.url), 'utf8'));

// The receipt is JSON in both human and --json mode.
export async function setupCommand(args) {
 try { return await setup(args); }
 catch (error) {
  // Paths, cookies and peer bodies must never appear in diagnostics.
  const code=typeof error?.message==='string'&&/^[a-z0-9_]{1,100}$/.test(error.message)?error.message:'business_setup_failed';
  process.stderr.write(JSON.stringify({code})+'\n');return 1;
 }
}

async function setup(args){
 const options={};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--json'&&!options.json){options.json=true;continue;}
  if(args[i]==='--confirm-demo'){options.confirm=true;continue;}
  if(!['--origin','--session-file','--hosting'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('demo_arguments_invalid');
  options[args[i]]=args[++i];
 }
 if(!options.confirm||!options['--origin']||!options['--session-file'])throw Error('demo_confirmation_and_session_file_required');
 const url=new URL(options['--origin']);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('demo_origin_invalid');
 const hosting=options['--hosting']??'managed';
 if(!['managed','assisted','self_host'].includes(hosting))throw Error('demo_arguments_invalid');
 const handle=await open(options['--session-file'],constants.O_RDONLY|constants.O_NOFOLLOW);
 let cookie;
 try{
  const stat=await handle.stat();if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid()||stat.size>16384)throw Error('demo_session_file_must_be_private');
  cookie=(await handle.readFile('utf8')).trim();
 }finally{await handle.close();}
 if(!/^(?:__Host-)?rer_session=[^\s;]+$/.test(cookie))throw Error('demo_session_file_invalid');
 const session=cookie.slice(cookie.indexOf('=')+1);
 try {
  const output=JSON.stringify(await createBusiness({origin:url.origin,cookie,hosting}),null,2)+'\n';
  if(output.includes(session))throw Error('demo_session_in_response');
  process.stdout.write(output);
  return 0;
 } catch(error) {
  if(String(error?.message).includes(session))throw Error('demo_session_in_response');
  throw error;
 }
}

/** Create, or reuse, the Business named in setup-company.json and give it that profile, through the owner's Business routes.
 * A repeat whose Business and profile already match reads only. Cookies and peer bodies never enter the receipt. */
async function createBusiness({origin,cookie,hosting}){
 const api=async(path,method='GET',body)=>{
  let response;
  try{response=await fetch(new URL(path,origin),{method,redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Error('platform_transport_unavailable');}
  let answer;try{answer=await response.json();}catch{throw Error(`platform_http_${response.status}`);}
  if(!response.ok){const code=answer?.code;throw Error(typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:`platform_http_${response.status}`);}
  return answer;
 };
 let business=(await api('/api/business')).businesses?.find(row=>row.name===company.name);
 const created=!business;
 if(created)business=(await api('/api/business','POST',{name:company.name,default_hosting:hosting,executor_preference:hosting==='self_host'?'local':'managed'})).business;
 if(typeof business?.id!=='string')throw Error('platform_business_invalid');
 if(business.default_hosting!==hosting)throw Error('existing_demo_hosting_differs');
 const root='/api/business/'+encodeURIComponent(business.id);
 const current=created?{}:(await api(root+'/profile')).profile??{};
 const changed=Object.entries(company.profile).some(([field,value])=>current[field]!==value);
 if(changed)await api(root+'/profile','PUT',company.profile);
 return {business_id:business.id,name:company.name,default_hosting:hosting,created,profile:changed?'saved':'unchanged'};
}
