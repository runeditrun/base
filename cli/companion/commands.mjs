import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sandboxCommand} from './providers/sandbox.mjs';
const exec=promisify(execFile);
// These argv lists are approved at the local terminal, never supplied by browser jobs.
export function validateCommands(value) {
 if(!value||!Object.keys(value).every(k=>['setup','verify'].includes(k)))throw new Error('Expected setup and verify argv lists.');
 for(const commands of Object.values(value)) if(!Array.isArray(commands)||commands.length>10||!commands.every(argv=>Array.isArray(argv)&&argv.length>0&&argv.length<50&&argv.every(a=>typeof a==='string'&&a.length<2000)))throw new Error('Invalid command argv lists.');
 return value;
}
export async function runCommands(commands,cwd,env) {
 if(!commands?.length)return [];
 const results=[];
 for(const argv of commands) {
  const sandbox=sandboxCommand(argv[0],cwd,env);
  let exit_code=0;
  try{await exec(sandbox.command,[...sandbox.args,...argv.slice(1)],{cwd,env:sandbox.env,timeout:300000,maxBuffer:1024*1024});}catch(error){exit_code=Number.isInteger(error.code)?error.code:1;}
  results.push({command:argv.join(' '),exit_code});
  if(exit_code!==0)break;
 }
 return results;
}
