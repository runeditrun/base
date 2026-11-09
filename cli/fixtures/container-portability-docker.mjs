#!/usr/bin/env node
// Only Docker's process/filesystem edge is fake. The transfer child runs the
// production transfer code, real SQLite D1 and object adapters, and policy.
import { mkdir, cp, readFile, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transfer, transferFailure } from '../../modules/container/transfer.mjs';
const root=process.cwd(),fixture=join(root,'.rer/container-fixture');
const [verb,...args]=process.argv.slice(2);
const home=name=>join(fixture,'containers',name);
const location=value=>{const index=value.indexOf(':/');return index<0?value:join(home(value.slice(0,index)),value.slice(index+2));};
await appendFile(join(fixture,'calls'),verb+'\n');
if(verb==='create'){
 const name=args[args.indexOf('--name')+1];
 for(const dir of ['private','archive'])await mkdir(join(home(name),dir),{recursive:true});
 console.log(name);
}else if(verb==='cp'){
 const [from,to]=args;await cp(location(from),location(to),{recursive:true});
}else if(verb==='start'){
 const directory=home(args.at(-1));
 try{
  const spec=JSON.parse(await readFile(join(directory,'private/transfer.json'),'utf8'));
  console.log(JSON.stringify({ok:true,...await transfer(spec,{root:join(fixture,'app'),data:join(fixture,'data'),archive:join(directory,'archive'),policyRoot:join(directory,'private/policy')})}));
 }catch(cause){console.error(cause);const failure=transferFailure(cause);console.log(JSON.stringify(failure));process.exitCode=failure.refused?4:1;}
}else if(verb==='rm')await rm(home(args.at(-1)),{recursive:true,force:true});
else if(verb!=='stop')throw new Error('Unexpected Docker verb');
