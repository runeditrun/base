const address=/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/;
const providers=['cloudflare','resend','sendgrid','mailgun'];
// Match the release adapter's named sending-key contract, without provider I/O.
export function mailgunIssues(env={},hasKey=key=>typeof env[key]==='string'&&Boolean(env[key].trim())&&!/[^\x21-\x7e]/.test(env[key])){
 const missing=[];
 if(env.EMAIL_API_KEY_NAME!=='MAILGUN_SENDING_KEY')missing.push('EMAIL_API_KEY_NAME (must name MAILGUN_SENDING_KEY)');
 if(typeof env.MAILGUN_DOMAIN!=='string'||!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(env.MAILGUN_DOMAIN))missing.push('MAILGUN_DOMAIN');
 if(env.MAILGUN_REGION!==undefined&&!['us','eu'].includes(env.MAILGUN_REGION))missing.push('MAILGUN_REGION (us or eu)');
 if(!address.test(env.EMAIL_FROM))missing.push('EMAIL_FROM');
 if(!hasKey('MAILGUN_SENDING_KEY'))missing.push('MAILGUN_SENDING_KEY');
 return missing;
}
export function normalizeEmail(input={},env={}){
 const provider=input.provider??env.EMAIL_PROVIDER??(env.EMAIL_API_KEY?'resend':'later');
 if(![...providers,'later'].includes(provider))throw new Error('Choose Cloudflare Email Sending, Resend, SendGrid, Mailgun, or set up email later.');
 if(provider==='later')return {provider};
 if(provider==='mailgun'){
  const values={EMAIL_API_KEY_NAME:input.apiKeyName??env.EMAIL_API_KEY_NAME,MAILGUN_DOMAIN:input.domain??env.MAILGUN_DOMAIN,MAILGUN_REGION:input.region??env.MAILGUN_REGION,EMAIL_FROM:input.from??env.EMAIL_FROM,MAILGUN_SENDING_KEY:input.sendingKey??env.MAILGUN_SENDING_KEY};
  const missing=mailgunIssues(values);
  if(missing.length)throw Error('Missing or invalid Mailgun configuration: '+missing.join(', ')+'.');
  return {provider,from:values.EMAIL_FROM,apiKeyName:values.EMAIL_API_KEY_NAME,domain:values.MAILGUN_DOMAIN.toLowerCase(),region:values.MAILGUN_REGION??'us',sendingKey:values.MAILGUN_SENDING_KEY};
 }
 const configuredProvider=env.EMAIL_PROVIDER??(env.EMAIL_API_KEY?'resend':'later');
 const configuredAccount=String(env.EMAIL_ACCOUNT_ID||env.CLOUDFLARE_ACCOUNT_ID||'').trim();
 const from=String(input.from||env.EMAIL_FROM||'').trim(),accountId=String(input.accountId||env.EMAIL_ACCOUNT_ID||env.CLOUDFLARE_ACCOUNT_ID||'').trim(),apiKey=String(input.apiKey||(provider===configuredProvider&&(provider!=='cloudflare'||accountId===configuredAccount)?env.EMAIL_API_KEY:'')||'').trim();
 if(!address.test(from))throw new Error('Enter a sender email address on your sending domain.');
 if(!apiKey)throw new Error('Add an email sending API token.');
 if(provider==='cloudflare'&&!/^[a-f0-9]{32}$/i.test(accountId))throw new Error('Choose the Cloudflare account that owns the sending domain.');
 return {provider,from,accountId:provider==='cloudflare'?accountId:'',apiKey};
}
export function emailEnvironment(config){
 if(config.provider==='later')return {};
 if(config.provider==='mailgun'){
  const normalized=normalizeEmail(config);
  return {EMAIL_PROVIDER:'mailgun',EMAIL_FROM:normalized.from,EMAIL_API_KEY_NAME:normalized.apiKeyName,MAILGUN_DOMAIN:normalized.domain,MAILGUN_REGION:normalized.region,MAILGUN_SENDING_KEY:normalized.sendingKey};
 }
 return {EMAIL_PROVIDER:config.provider,EMAIL_FROM:config.from,EMAIL_API_KEY:config.apiKey,...(config.provider==='cloudflare'?{EMAIL_ACCOUNT_ID:config.accountId}:{})};
}
export function emailMetadata(env={}){
 const provider=env.EMAIL_PROVIDER??(env.EMAIL_API_KEY?'resend':'later'),from=typeof env.EMAIL_FROM==='string'?env.EMAIL_FROM:'',accountId=env.EMAIL_ACCOUNT_ID||env.CLOUDFLARE_ACCOUNT_ID||'';
 if(provider==='mailgun')return {provider,from,domain:env.MAILGUN_DOMAIN||'',region:env.MAILGUN_REGION??'us',apiKeyName:env.EMAIL_API_KEY_NAME==='MAILGUN_SENDING_KEY'?'MAILGUN_SENDING_KEY':'',credentialPresent:!mailgunIssues(env).includes('MAILGUN_SENDING_KEY'),configuration:mailgunIssues(env).length?'missing':'configured',domainVerification:'not_checked',outbound:'not_tested',inbound:'not_configured',magicLinks:false,requirements:['Verify the sending domain in Mailgun.','Set EMAIL_API_KEY_NAME to MAILGUN_SENDING_KEY and supply that domain sending key separately; never use a Routes key.','Choose the sending domain’s US or EU region (US by default).']};
 const credentialPresent=Boolean(env.EMAIL_API_KEY),configured=credentialPresent&&address.test(from)&&providers.includes(provider)&&(provider!=='cloudflare'||/^[a-f0-9]{32}$/i.test(accountId));
 const requirements=provider==='cloudflare'?['Workers Paid and Email Sending access are required for customer email.','Onboard the sender domain in Cloudflare Email Sending; Cloudflare DNS is required.','Use a dedicated API token with Email Sending: Edit permission.','Email Routing is separate; verified-destination-only sending is not general customer delivery.']:provider==='sendgrid'?['Verify the sender domain in SendGrid before sending.','Use a SendGrid Mail Send API key with mail.send permission.','Configure SendGrid Inbound Parse separately when customer replies must return to the native inbound route.']:provider==='resend'?['Verify your sender domain in Resend.','Use a Resend sending API key.']:['Choose a provider and sender before enabling email.'];
 return {provider,from,domain:address.test(from)?from.split('@')[1]:'',accountId,credentialPresent,configuration:configured?'configured':'missing',domainVerification:'not_checked',outbound:'not_tested',inbound:'not_configured',magicLinks:false,requirements};
}
