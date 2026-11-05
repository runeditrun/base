import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEmail,emailEnvironment,emailMetadata} from './email.mjs';

const mailgun={EMAIL_PROVIDER:'mailgun',EMAIL_API_KEY_NAME:'MAILGUN_SENDING_KEY',MAILGUN_DOMAIN:'MG.Example.test',EMAIL_FROM:'support@example.test',MAILGUN_SENDING_KEY:'synthetic-domain-sending-token'};
test('Mailgun normalization and metadata retain domain and region semantics without exposing credentials',()=>{
 for(const region of [undefined,'us','eu']){
  const env={...mailgun,...(region?{MAILGUN_REGION:region}:{})};
  const result=emailEnvironment(normalizeEmail({},env));
  assert.equal(result.MAILGUN_DOMAIN,'mg.example.test');assert.equal(result.MAILGUN_REGION,region??'us');
  assert.equal(result.EMAIL_API_KEY_NAME,'MAILGUN_SENDING_KEY');assert.equal(result.MAILGUN_SENDING_KEY,mailgun.MAILGUN_SENDING_KEY);
  assert.ok(!('EMAIL_API_KEY' in result));
  const metadata=emailMetadata(result);
  assert.equal(metadata.configuration,'configured');assert.equal(metadata.outbound,'not_tested');assert.equal(metadata.domainVerification,'not_checked');
  assert.ok(!JSON.stringify(metadata).includes(mailgun.MAILGUN_SENDING_KEY));
 }
});
test('Mailgun normalization rejects missing settings and generic, Routes or other-provider fallback',()=>{
 for(const name of ['MAILGUN_DOMAIN','EMAIL_FROM','MAILGUN_SENDING_KEY','EMAIL_API_KEY_NAME']){
  const env={...mailgun,[name]:'',EMAIL_API_KEY:'synthetic-generic-token',MAILGUN_ROUTES_KEY:'synthetic-routes-token',RESEND_API_KEY:'synthetic-resend-token',SENDGRID_API_KEY:'synthetic-sendgrid-token'};
  assert.throws(()=>normalizeEmail({},env),error=>error.message.includes(name)&&!error.message.includes('synthetic-'));
  assert.equal(emailMetadata(env).configuration,'missing');
 }
 for(const name of ['MAILGUN_ROUTES_KEY','EMAIL_API_KEY','SENDGRID_API_KEY',mailgun.MAILGUN_SENDING_KEY])assert.throws(()=>normalizeEmail({apiKeyName:name},mailgun),/EMAIL_API_KEY_NAME/);
 for(const region of ['', 'US', 'ap'])assert.throws(()=>normalizeEmail({region},mailgun),/MAILGUN_REGION/);
 for(const domain of ['', 'https://mg.example.test','bad..example.test','mg.example.test/path'])assert.throws(()=>normalizeEmail({domain},mailgun),/MAILGUN_DOMAIN/);
 assert.equal(emailMetadata({...mailgun,EMAIL_API_KEY_NAME:mailgun.MAILGUN_SENDING_KEY}).apiKeyName,'');
});
test('existing email providers keep their own settings and Cloudflare account guard',()=>{
 for(const provider of ['resend','sendgrid','cloudflare']){
  const input={provider,from:'support@example.test',apiKey:'synthetic-existing-token',accountId:'a'.repeat(32)};
  const env=emailEnvironment(normalizeEmail(input));
  assert.equal(env.EMAIL_PROVIDER,provider);assert.equal(env.EMAIL_API_KEY,input.apiKey);
  assert.equal(emailMetadata(env).configuration,'configured');assert.ok(!('MAILGUN_SENDING_KEY' in env));
 }
 assert.throws(()=>normalizeEmail({provider:'cloudflare',accountId:'b'.repeat(32)}, {EMAIL_PROVIDER:'cloudflare',EMAIL_ACCOUNT_ID:'a'.repeat(32),EMAIL_API_KEY:'synthetic-old-account-token',EMAIL_FROM:'support@example.test'}),/API token/);
 assert.deepEqual(emailEnvironment(normalizeEmail({provider:'later'})),{});
 assert.throws(()=>normalizeEmail({provider:''},{EMAIL_API_KEY:'synthetic-generic-token'}),/Choose/);
});
