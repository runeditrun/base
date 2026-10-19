import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOperatorAuth } from '../../operator-auth/index.mjs';
import { applySql } from '../../operator-auth/tests/apply-sql.mjs';
import { createPortability, makePart } from '../index.mjs';
import { ArchiveVerifier, ContentVerifier } from '../format.mjs';
import { database, bundle, stage, rows } from './regression-helpers.mjs';

const authSchema=await readFile(new URL('../../operator-auth/accounts/schema/operator-auth.sql',import.meta.url),'utf8');
const identityPolicy={product:'signin-history',includeTables:['oa_operators','oa_sessions','oa_tokens']};
async function authDatabase(t) {
 const f=await database(t,[],{product:identityPolicy.product});
 await applySql(f.db,authSchema);
 f.service=await createPortability({db:f.db,policy:identityPolicy});
 return f;
}

test('session admission records durable sign-in history through OIDC session scrubbing and restore',async t=>{
 const source=await authDatabase(t),target=await authDatabase(t),now=Date.now();
 const origin='https://app.example',issuer='https://issuer.example';
 const auth=createOperatorAuth({db:source.db,clientIp:()=> '192.0.2.1',clock:()=>now,
  config:{origin,OWNER_EMAIL:'owner@example.com',SESSION_SECRET:'test-session-secret-at-least-32-bytes',SETUP_TOKEN:'test-setup-secret-at-least-32-bytes',externalIssuers:[issuer]}});
 const request=path=>new Request(origin+path,{method:'POST',headers:{Host:'app.example',Origin:origin}});
 const owner=await auth.bootstrap(request('/auth/bootstrap'),{token:'test-setup-secret-at-least-32-bytes',displayName:'Owner'});
 await auth.setIdentitySettings(new Request(origin+'/auth/settings/identity',{method:'POST',headers:{Host:'app.example',Origin:origin,Cookie:owner.cookie.split(';')[0]}}),{idpSignIn:true});
 await source.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('member','member@example.com','Member','member','active',?)").bind(now-200*86400000).run();
 await auth.admitVerifiedIdentity(request('/auth/oidc/callback'),{issuer,subject:'member',email:'member@example.com',emailVerified:true});
 const signin=await source.db.prepare("SELECT last_signin_at FROM oa_operators WHERE id='member'").first();
 assert.equal(signin.last_signin_at,now);
 const archive=await bundle(source.service);
 assert.equal(rows(archive).filter(x=>x.table==='oa_sessions' && x.row.kind==='oidc').length,0);
 assert.equal((await source.db.prepare("SELECT COUNT(*) n FROM oa_sessions WHERE kind='oidc'").first()).n,1,'export scrubs its snapshot only');
 const id=await stage(target.service,archive);
 await target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash});
 assert.equal((await target.db.prepare("SELECT last_signin_at FROM oa_operators WHERE id='member'").first()).last_signin_at,now);
 assert.equal((await target.db.prepare("SELECT COUNT(*) n FROM oa_sessions WHERE operator_id='member'").first()).n,0);
});

const ddl=[
 'CREATE TABLE oa_operators(id TEXT PRIMARY KEY)',
 'CREATE TABLE oa_policy_approvals(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES oa_operators(id),approved_at INTEGER NOT NULL,revoked_at INTEGER)',
 'CREATE TABLE oa_policy_runs(id TEXT PRIMARY KEY,approval_id TEXT REFERENCES oa_policy_approvals(id),status TEXT)',
];
const policy={product:'policy-provenance',includeTables:['oa_operators','oa_policy_approvals','oa_policy_runs']};
async function approved(t,extra={}) {
 const source=await database(t,ddl,{...policy,...extra});
 await source.db.batch(["INSERT INTO oa_operators VALUES('owner')","INSERT INTO oa_policy_approvals VALUES('live','owner',1000,NULL),('revoked','owner',1000,2000)","INSERT INTO oa_policy_runs VALUES('run','live','completed')"].map(sql=>source.db.prepare(sql)));
 return source;
}

test('export revokes copied delegations while preserving source authority, provenance and run references; import refuses a re-signed live approval',async t=>{
 const source=await approved(t),target=await database(t,ddl,policy),archive=await bundle(source.service);
 const approvals=rows(archive).filter(x=>x.table==='oa_policy_approvals');
 assert.ok(approvals.every(x=>x.row.revoked_at!==null));
 assert.equal(approvals.find(x=>x.row.id==='revoked').row.revoked_at,2000);
 assert.equal((await source.db.prepare("SELECT revoked_at FROM oa_policy_approvals WHERE id='live'").first()).revoked_at,null);
 const id=await stage(target.service,archive);
 await target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash});
 assert.equal((await target.db.prepare("SELECT a.revoked_at,r.status FROM oa_policy_runs r JOIN oa_policy_approvals a ON a.id=r.approval_id WHERE r.id='run'").first()).status,'completed');
 assert.ok((await target.db.prepare("SELECT revoked_at FROM oa_policy_approvals WHERE id='live'").first()).revoked_at!==null);
 const hostile=structuredClone(archive);
 for(let i=0;i<hostile.parts.length;i++) {
  const part=hostile.parts[i];
  for(const item of part.items)if(item.table==='oa_policy_approvals' && item.row.id==='live')item.row.revoked_at=null;
  hostile.parts[i]=await makePart(part.index,part.items);
 }
 const integrity=new ArchiveVerifier(hostile.manifest),content=new ContentVerifier(hostile.manifest);
 for(const part of hostile.parts){integrity.add(part);for(const item of part.items)content.add(item);}
 const empty=await database(t,ddl,policy),badId=await stage(empty.service,hostile);
 await assert.rejects(empty.service.imports.finalize(badId,{archiveHash:integrity.digest(),contentHash:content.digest()}),error=>error.code==='live_policy_approval' && error.status===409);
 assert.equal((await empty.db.prepare('SELECT COUNT(*) n FROM oa_operators').first()).n,0);
 assert.equal((await empty.db.prepare('SELECT COUNT(*) n FROM oa_policy_approvals').first()).n,0);
});

test('an export row transform cannot revive a scrubbed policy approval',async t=>{
 const source=await approved(t,{exportRow(table,row){if(table==='oa_policy_approvals')row.revoked_at=null;return row;}});
 await assert.rejects(bundle(source.service),error=>error.code==='live_policy_approval');
});
