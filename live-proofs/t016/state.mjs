import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, insist } from '../../scripts/qualification/operations.mjs';
import { readMedia, ownerRecheck } from '../../scripts/qualification/happytohelp.mjs';
import { verifyMigrationTransition } from './cloudflare.mjs';

export function migrationBytes(cwd) {
  const directories = [join(cwd, 'migrations'), ...readdirSync(join(cwd, 'src/modules'), { withFileTypes: true })
    .filter(x => x.isDirectory()).map(x => join(cwd, 'src/modules', x.name, 'migrations'))];
  const files = [];
  for (const directory of directories) {
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.filter(x => x.name.endsWith('.sql'))) {
      insist(entry.isFile() && /^\d+_[a-z0-9_-]+\.sql$/.test(entry.name), 'invalid-source-migration');
      files.push({ name: entry.name, sha256: digest(readFileSync(join(directory, entry.name))) });
    }
  }
  files.sort((a,b) => a.name.localeCompare(b.name));
  insist(files.length > 0 && new Set(files.map(f => f.name)).size === files.length, 'duplicate-migration');
  return files;
}
export function verifyAppliedBytes(before, after) {
  insist(before.length > 0 && JSON.stringify(before) === JSON.stringify(after), 'applied-migration-bytes-changed');
}
function verifyMessages(messages, state) {
  const { reply, owner, conversationId, requestContent, replyContent } = state;
  insist(reply && owner && [conversationId, reply.visitorId, owner.userId,
    reply.visitorMessageId, reply.operatorMessageId, requestContent, replyContent]
    .every(value => typeof value === 'string' && value.length > 0) &&
    reply.visitorMessageId !== reply.operatorMessageId && reply.conversationId === conversationId &&
    reply.requestSha256 === digest(requestContent) && reply.replySha256 === digest(replyContent), 'representative-data-incomplete');
  const expected = [
    [reply.visitorMessageId, reply.visitorId, 'contact', requestContent, reply.requestSha256],
    [reply.operatorMessageId, owner.userId, 'owner', replyContent, reply.replySha256],
  ];
  // Bind the first independent D1 snapshot to the journey, before its digest can
  // become the baseline for upgrade/rollback continuity checks.
  insist(messages.length === expected.length && expected.every(([id, actor, role, content, hash]) =>
    messages.some(message => message.id === id && message.conversation_id === conversationId &&
      message.actor_id === actor && message.actor_role === role && message.content === content &&
      digest(message.content) === hash)), 'prior-data-changed');
}
export async function snapshotState({ read, state, origin, migrations }) {
  // Credential hashes and session rows never leave D1. These are representative
  // application records created through the real owner/widget/operator journey.
  const statements = [
    ['owner','SELECT id,name,created_at FROM users WHERE id=?',[state.owner.userId]],
    ['project','SELECT id,name,allowed_origin,created_at FROM projects WHERE id=?',[state.owner.projectId]],
    ['membership','SELECT project_id,user_id,role FROM memberships WHERE project_id=? AND user_id=?',[state.owner.projectId,state.owner.userId]],
    ['contact','SELECT id,project_id,name,created_at FROM contacts WHERE id=?',[state.reply.visitorId]],
    ['conversation','SELECT id,project_id,contact_id,revision,last_message_id,created_at,updated_at FROM conversations WHERE id=?',[state.conversationId]],
    ['messages','SELECT id,conversation_id,local_id,actor_id,actor_role,content,revision,created_at FROM messages WHERE conversation_id=? ORDER BY revision',[state.conversationId]],
    ['media','SELECT id,conversation_id,object_key,filename,content_type,size,message_id FROM media WHERE id=?',[state.media.mediaId]],
  ];
  const rows = {};
  for (const [name,sql,params] of statements) { rows[name] = await read(sql,params); insist(rows[name].length > 0, 'prior-data-missing'); }
  insist(rows.messages.length === 2 && rows.membership[0].role === 'owner' && rows.media[0].message_id === state.reply.visitorMessageId, 'representative-data-incomplete');
  verifyMessages(rows.messages, state);
  const ledger = await read('SELECT id,name,applied_at FROM d1_migrations ORDER BY id');
  insist(ledger.length === migrations.length && migrations.every(file => ledger.some(row => row.name === file.name)), 'migration-ledger-incomplete');
  const mediaSha256 = await readMedia(origin,state);
  insist(mediaSha256 === state.media.sha256, 'prior-media-changed');
  return { rowsSha256: digest(rows), ledger, ledgerSha256: digest(ledger), mediaSha256,
    sourceMigrationsSha256: digest(migrations), names: migrations.map(x => x.name) };
}
export async function recheckState({ before, read, state, origin, migrations, previousMigrations, browser }) {
  verifyAppliedBytes(previousMigrations,migrations);
  const after = await snapshotState({ read,state,origin,migrations });
  verifyMigrationTransition(before.ledger,after.ledger,true);
  insist(after.rowsSha256 === before.rowsSha256 && after.ledgerSha256 === before.ledgerSha256 &&
    after.mediaSha256 === before.mediaSha256 && after.sourceMigrationsSha256 === before.sourceMigrationsSha256, 'prior-data-changed');
  await ownerRecheck(origin,state,browser);
  return after;
}
