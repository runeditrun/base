import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
// Trusted adapter only. Values never leave this closure or enter a provider prompt.
export function providerSecretGuard(env) {
  const values=[env.ANTHROPIC_API_KEY,env.ANTHROPIC_AUTH_TOKEN].filter(Boolean);
  const auth=join(env.HOME,'.codex','auth.json');
  if(existsSync(auth)) {
    const data=JSON.parse(readFileSync(auth,'utf8'));
    for(const [key,value] of Object.entries({...data,...data.tokens})) if(/token|api_key/i.test(key)&&typeof value==='string'&&value.length>8)values.push(value);
  }
  // OAuth credentials may be persisted by Claude Code in its dedicated
  // executor home. Read only credential-shaped fields there; never inspect the
  // host HOME or macOS Keychain to construct this guard.
  for (const path of [join(env.HOME,'.claude','.credentials.json'),join(env.HOME,'.claude.json')]) {
    if (!existsSync(path)) continue;
    try {
      const data=JSON.parse(readFileSync(path,'utf8'));
      const collect=(value,key='')=>{
        if (value&&typeof value==='object') for (const [name,item] of Object.entries(value)) collect(item,name);
        else if (typeof value==='string'&&value.length>8&&/(token|secret|credential|api.?key|access.?token|refresh.?token)/i.test(key)) values.push(value);
      };
      collect(data);
    } catch { /* Invalid provider state is handled by the provider itself. */ }
  }
  const variants=[...new Set(values.flatMap(value=>[value,encodeURIComponent(value),Buffer.from(value).toString('base64')]))];
  const clean=value=>{
    if(typeof value==='string')return variants.reduce((text,secret)=>text.split(secret).join('[REDACTED PROVIDER CREDENTIAL]'),value);
    if(Array.isArray(value))return value.map(clean);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)]));
    return value;
  };
  return {redact:clean,assertPublishable(result){
    const source=JSON.stringify(result)+'\n'+(result.files||[]).filter(file=>file.contentBase64).map(file=>Buffer.from(file.contentBase64,'base64').toString('utf8')).join('\n');
    if(variants.some(secret=>source.includes(secret)))throw new Error('Provider credential detected in proposed result; publication blocked. Inspect the retained worktree locally.');
  }};
}
