import assert from 'node:assert/strict';
import { digest } from '../../scripts/qualification/operations.mjs';
import { verifyAppliedBytes, recheckState, snapshotState } from '../t016/state.mjs';
export const upgradeRows = [];

upgradeRows.push(['immutable migration bytes reject edited, added and deleted applied history', {}, ()=>{
 const prior=[{name:'0001_initial.sql',sha256:digest('original')}];
 verifyAppliedBytes(prior,structuredClone(prior));
 for(const next of [[],[{...prior[0],sha256:digest('changed')}],[...prior,{name:'0002_new.sql',sha256:digest('new')}]])
  assert.throws(()=>verifyAppliedBytes(prior,next),/migration-bytes-changed/);
}]);
upgradeRows.push(['upgrade readback detects changed representative rows and missing R2 bytes before login can mask loss', {}, async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 const state={owner:{userId:'owner-id',projectId:'project-id',token:'test-session'},
  reply:{conversationId:'conversation-id',visitorId:'visitor-id',visitorMessageId:'message-1',operatorMessageId:'message-2',
   requestSha256:digest('request'),replySha256:digest('reply')},requestContent:'request',replyContent:'reply',
  conversationId:'conversation-id',media:{mediaId:'media-id',sha256:digest('media')}};
 let changed=false,media='media';
 const migrations=[{name:'0001_initial.sql',sha256:digest('sql')}];
 const read=async sql=>sql.includes('d1_migrations')?[{id:1,name:'0001_initial.sql',applied_at:'2026-01-01'}]:
  sql.includes('FROM messages')?[
   {id:'message-1',conversation_id:'conversation-id',actor_id:'visitor-id',actor_role:'contact',content:changed?'changed':'request'},
   {id:'message-2',conversation_id:'conversation-id',actor_id:'owner-id',actor_role:'owner',content:'reply'}]:
  sql.includes('FROM memberships')?[{role:'owner'}]:sql.includes('FROM media')?[{message_id:'message-1'}]:[{id:'representative-id'}];
 globalThis.fetch=async()=>new Response(media);
 const before=await snapshotState({read,state,origin:'https://throwaway.example',migrations});
 changed=true;
 await assert.rejects(recheckState({before,read,state,origin:'https://throwaway.example',migrations,previousMigrations:migrations,
  browser(){assert.fail('Cannot verify login over lost prior data');}}),/prior-data-changed/);
 changed=false;media='lost';
 await assert.rejects(snapshotState({read,state,origin:'https://throwaway.example',migrations}),/prior-media-changed/);
}]);
