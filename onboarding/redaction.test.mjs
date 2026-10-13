import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedaction, credentialValues } from './redaction.mjs';

function captured(input, secrets=[], unit=1) {
 const redaction=createRedaction();redaction.addSecrets(secrets);
 let output='';const stream=redaction.stream(text=>{output+=text;});
 const bytes=Buffer.from(input);
 for(let offset=0;offset<bytes.length;offset+=unit)stream.write(bytes.subarray(offset,offset+unit));
 stream.end();return output;
}
function absent(output, values) {
 for(const value of values)assert.ok(!output.includes(value),'private bytes reached output');
}

test('environment credential names and URL userinfo register long values without registering flags',()=>{
 const names=['DATABASE_URL','STRIPE_KEY','GITHUB_PAT','key','pat','dsn','auth','pass','signature','sig'];
 const environment=Object.fromEntries(names.map((name,index)=>[name,`synthetic-credential-${index}`]));
 environment.DATABASE_URL='postgres://database-user:database-private-test-pass@db.invalid/name';
 environment.UNRELATED_ENDPOINT='https://url-user:url-private-test-pass@host.invalid/';
 Object.assign(environment,{COOKIE_SECURE:'1',AUTH_ENABLED:'true',TOKEN_FLAG:'false',API_KEY:'tiny'});
 const registered=credentialValues(environment),redaction=createRedaction();redaction.addSecrets(registered);
 for(const name of [...names,'UNRELATED_ENDPOINT'])assert.ok(registered.includes(environment[name]),'credential field was not registered');
 for(const name of ['COOKIE_SECURE','AUTH_ENABLED','TOKEN_FLAG','API_KEY'])assert.ok(!registered.includes(environment[name]),'a short environment flag was registered');
 assert.equal(redaction.redact('build 1 of 10 true false tiny'),'build 1 of 10 true false tiny');
 const explicit=createRedaction();explicit.addSecrets(credentialValues({pin:'12'},['pin']));
 assert.equal(explicit.redact('value 12'),'value [REDACTED]');
});

test('raw, base64, base64url and percent-encoded registered credentials survive every split byte',()=>{
 const secret='synth-päss/word?=# private-42';
 const forms=[secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url'),encodeURIComponent(secret),encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g,value=>value.toLowerCase()),encodeURIComponent(secret).replace(/%20/g,'+')];
 for(const form of forms)for(const unit of [1,2,7,4096]) {
  const output=captured(`BEFORE_MARKER\n${form}\nAFTER_MARKER\n`,[secret],unit);
  absent(output,[form,secret]);assert.match(output,/BEFORE_MARKER/);assert.match(output,/AFTER_MARKER/);assert.match(output,/\[REDACTED\]/);
 }
});

test('credential shapes redact in one buffer and across individual bytes with nearby diagnostics intact',()=>{
 const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
 const cases=[
  ['https://url-user:test-private-userinfo@host.invalid/path','private-userinfo'],
  ['Authorization: Basic '+Buffer.from('sample-user:private-basic-password').toString('base64'),Buffer.from('sample-user:private-basic-password').toString('base64')],
  ['https://host.invalid/?sig=private-query-signature&safe=public','private-query-signature'],
  ['https://host.invalid/?signature=other-private-signature&safe=public','other-private-signature'],
  ['https://host.invalid/?key=private-query-key&safe=public','private-query-key'],
  ['-----BEGIN RSA PRIVATE KEY-----\nTEST_PRIVATE_PEM_BODY_ONE\nPRIVATE_PEM_BODY_TWO\n-----END RSA PRIVATE KEY-----','PRIVATE_PEM_BODY_ONE'],
  [pkcs8,pkcs8.split('\n')[1]],
 ];
 for(const [text,privatePart] of cases)for(const unit of [1,3,4096]) {
  const output=captured('BEFORE_MARKER\n'+text+'\nAFTER_MARKER\n',[],unit);
  absent(output,[privatePart]);assert.match(output,/BEFORE_MARKER/);assert.match(output,/AFTER_MARKER/);assert.match(output,/\[REDACTED\]/);
  if(text.includes('&safe='))assert.match(output,/&safe=public/);
 }
});

test('snapshot and EOF never expose an incomplete secret, PEM header, body, Basic value or URL userinfo',()=>{
 const known='registered-private-value-ends-here';
 const encrypted = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: known }).split('\n');
 for(const [partial,privatePart] of [
  [known.slice(0,18),known.slice(0,18)],
  [Buffer.from(known).toString('base64').slice(0,18),Buffer.from(known).toString('base64').slice(0,18)],
  ['-----BEGIN RSA PRIVATE','-----BEGIN RSA PRIVATE'],
  [encrypted.slice(0,2).join('\n'),encrypted[1]],
  ['Authorization: Basic '+Buffer.from('synthetic-private').toString('base64'),Buffer.from('synthetic-private').toString('base64')],
  ['https://private-user:private-pass','private-user:private-pass'],
 ]) {
  const redaction=createRedaction();redaction.addSecrets(known);let output='';const stream=redaction.stream(text=>{output+=text;});
  for(const byte of Buffer.from('NEARBY_MARKER\n'+partial))stream.write(Buffer.from([byte]));
  absent(output+stream.snapshot(),[privatePart]);assert.match(output+stream.snapshot(),/NEARBY_MARKER/);
  stream.end();absent(output,[privatePart]);assert.match(output,/\[REDACTED\]/);
 }
});

test('oversized PEM bodies stay bounded and private through a split end marker',()=>{
 const pem='-----BEGIN OPENSSH PRIVATE KEY-----\nTEST_PRIVATE_BODY_FRAGMENT\n-----END OPENSSH PRIVATE KEY-----';
 const [header,fragment,footer]=pem.split('\n');
 const redaction=createRedaction();let output='';const stream=redaction.stream(text=>{output+=text;});
 stream.write(`BEFORE_MARKER\n${header}\n`);
 for(let index=0;index<100;index++) {
  stream.write(fragment.repeat(100));assert.ok(stream.bufferedLength<17000);
  absent(output+stream.snapshot(),[fragment]);
 }
 for(const char of `\n${footer}\nAFTER_MARKER\n`)stream.write(char);
 stream.end();absent(output,[fragment]);assert.match(output,/BEFORE_MARKER/);assert.match(output,/AFTER_MARKER/);assert.ok(output.length<200);
});

test('C1, DEL, bidi and control-string payloads are removed across UTF-8 byte boundaries',()=>{
 const input='BEFORE_MARKER\n'+
  '\x9d52;c;PRIVATE_OSC_PAYLOAD\x9c'+
  '\x90PRIVATE_DCS_PAYLOAD\x9c'+
  '\x9ePRIVATE_PM_PAYLOAD\x9c'+
  '\x9fPRIVATE_APC_PAYLOAD\x9c'+
  '\x1b]PRIVATE_ESC_OSC\x07'+
  '\x1bPPRIVATE_ESC_DCS\x1b\\'+
  '\x9b31mPUBLIC_TEXT\x9b0m\x7f\x80\x85\u202a\u202e\u2066\u2069\nAFTER_MARKER\n';
 const output=captured(input);
 absent(output,['PRIVATE_']);assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(output));
 assert.match(output,/BEFORE_MARKER/);assert.match(output,/PUBLIC_TEXT/);assert.match(output,/AFTER_MARKER/);
 assert.equal(createRedaction().redact(input),output);
});

test('unterminated OSC and DCS recover on newline, at 4 KiB, and after end resets state',()=>{
 for(const start of ['\x1b]','\x1bP','\x9d','\x90']) {
  const output=captured('BEFORE_MARKER\n'+start+'PRIVATE_SEQUENCE\nAFTER_MARKER\n');
  absent(output,['PRIVATE_SEQUENCE']);assert.match(output,/AFTER_MARKER/);
  assert.match(captured(start+'x'.repeat(4200)+'RECOVERED_MARKER\n'),/RECOVERED_MARKER/);
  const redaction=createRedaction();let reset='';const stream=redaction.stream(text=>{reset+=text;});
  stream.write(start+'PRIVATE_SEQUENCE');stream.end();stream.write('RESET_MARKER\n');stream.end();
  assert.equal(reset,'RESET_MARKER\n');
 }
});
