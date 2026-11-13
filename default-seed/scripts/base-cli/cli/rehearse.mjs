import {rehearseOptions, rehearseHelp} from './rehearse/options.mjs';
import {rehearse} from './rehearse/run.mjs';
import {output} from './output.mjs';

export async function rehearseCommand(args) {
 let options={verb:'rehearse',json:args.includes('--json')}, out=output(options);
 try {
  options={...rehearseOptions(args),verb:'rehearse'};out=output(options);
  if(options.help){if(options.json)out.event('help',{usage:rehearseHelp});else out.human(rehearseHelp);return 0;}
  const result=await rehearse(options,options.json?undefined:text=>out.progress(text+'\n'));
  if(!options.json){
   for(const row of result.operations)out.human(`${row.status} ${row.name}${row.cause?`: ${row.cause}`:''}`);
   if(result.cause)out.human(`Could not prepare rehearsal: ${result.cause}`);
   if(result.captureLog)out.human(`Capture log: ${result.captureLog}`);
   if(result.scratch)out.human(`Kept scratch copy: ${result.scratch}`);
   out.human(`Elapsed: ${result.seconds}s`);
  }
  const {ok,exitCode,...details}=result;out.result(ok,exitCode,details);return exitCode;
 } catch(error){const code=error.exitCode??2;out.error({code:error.code??'invalid_invocation',message:error.message,exitCode:code});out.result(false,code);return code;}
}
