import { readSettings, replaceSavedSetting } from './adapter-settings.mjs';
import { commandFailure } from './failures.mjs';
import { writePrivateFile } from './private-files.mjs';

export const localOperatorMailProvider = 'development';

export function localOperatorSettings(vars) {
 if(vars.AUTH_LOCAL!=='true')return {field:'AUTH_LOCAL',found:JSON.stringify(vars.AUTH_LOCAL??'unset'),expected:'true'};
 if(vars.MAIL_PROVIDER!==localOperatorMailProvider)return {field:'MAIL_PROVIDER',found:JSON.stringify(vars.MAIL_PROVIDER??'unset'),expected:localOperatorMailProvider};
 if(!vars.SESSION_SECRET)return {field:'SESSION_SECRET',found:'unset',expected:'set'};
}

// AUTH_LOCAL does not suppress remote senders in every adopting seed. Keep the
// shared local contract explicit, including when a seed offers hosted mail-off.
export async function prepareOperatorMail({root,input}) {
 const saved=(await readSettings(root,{})).values;
 if(input.MAIL_PROVIDER!==undefined&&input.MAIL_PROVIDER!==localOperatorMailProvider&&!saved.OWNER_EMAIL) {
  throw commandFailure(`Local prerequisite MAIL_PROVIDER: found ${JSON.stringify(input.MAIL_PROVIDER)}; expected ${localOperatorMailProvider}; run ~/.local/bin/rer setup with MAIL_PROVIDER=${localOperatorMailProvider} in the --answers file.`,{});
 }
}

export async function repairOperatorMail(context) {
 if((context.verb&&!['installer','setup'].includes(context.verb))||context.vars.MAIL_PROVIDER===localOperatorMailProvider)return;
 const current=await readSettings(context.root,{});
 if(current.values.MAIL_PROVIDER===undefined){
  await writePrivateFile(current.path,current.text.replace(/\n*$/,'\n')+`MAIL_PROVIDER=${localOperatorMailProvider}\n`);
  context.vars={...context.vars,MAIL_PROVIDER:localOperatorMailProvider};
 }else context.vars=await replaceSavedSetting(context.root,{},'MAIL_PROVIDER',localOperatorMailProvider);
 context.store.report(`Local MAIL_PROVIDER was repaired to ${localOperatorMailProvider}; local mail is suppressed.`);
}
