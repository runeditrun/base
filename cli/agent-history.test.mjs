import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { checkAgentDoor } from './agent-door.mjs';
import { serveHosted } from './hosted-output.mjs';
import { historyDeclaration } from './agent-history.mjs';
import { runCommand } from './lifecycle.mjs';

const declaration = (binding = 'DB', sql = 'INSERT INTO fixture_history(id,value) VALUES (?,?)') => ({ module: 'tests/history.mjs', steps: ['create'], statements: { prior: { binding, sql } } });
async function seed(t) {
 const root = await fixtureSeed(t, 'signed');
 await mkdir(join(root, 'tests'));
 await writeFile(join(root, 'tests/history.mjs'), `export default { async fetch(request) {
 const {phase,now} = await request.json();
 if (!Number.isFinite(now)) throw Error('Isolation lost');
 return Response.json([{statement:'prior',values:[phase,'Previous native fact']}]);
} };`);
 await writeFile(join(root, 'dist/server/migrations/9998_history.sql'), 'CREATE TABLE fixture_history(id TEXT PRIMARY KEY,value TEXT);');
 await buildFixture(root);
 const file = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(file, 'utf8'));
 surface.verification.history = declaration();
 await writeFile(file, JSON.stringify(surface));
 return { root, file, surface };
}
const verify = root => checkAgentDoor(root, { report() {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });

test('history stays outside production commands and production imports are refused', { timeout: 120000 }, async t => {
 const { root } = await seed(t), outcomes = [];
 // A module incompatible with Node demonstrates that production validation
 // reads declarations without importing or executing the fixture.
 await writeFile(join(root, 'tests/history.mjs'), 'throw Error("must not execute outside verification"); export default {};');
 outcomes.push(Boolean(await historyDeclaration(root, declaration())));
 await writeFile(join(root, 'production.mjs'), "export {default} from './tests/history.mjs';");
 for (const verb of ['build', 'dev', 'preview', 'deploy']) {
  outcomes.push(await runCommand({ root, profile: 'first-party' }, { verb }, {}).then(() => false, error => error.code === 'agent_history_invalid'));
 }
 await writeFile(join(root, 'production.mjs'), "export {default} from './tests/bridge.mjs';");
 await writeFile(join(root, 'tests/bridge.mjs'), "export {default} from './history.mjs';");
 outcomes.push(await historyDeclaration(root, declaration()).then(() => false, error => error.code === 'agent_history_invalid'));
 await symlink(join(root, 'tests/history.mjs'), join(root, 'alias.mjs'));
 await writeFile(join(root, 'production.mjs'), "import './alias.mjs';");
 outcomes.push(await historyDeclaration(root, declaration()).then(() => false, error => error.code === 'agent_history_invalid'));
 assert.deepEqual(outcomes, Array(7).fill(true));
});

test('history inserts only into disposable declared databases and cannot forge protocol state', { timeout: 240000 }, async t => {
 const { root, file, surface } = await seed(t), outcomes = [];
 const phases = [];
 surface.verification.journey = 'tests/check-history.mjs';
 await writeFile(join(root, 'tests/check-history.mjs'), `export default async function() {};
 export async function beforeStep({database,phase,step}) {
 if(step.id !== 'create' || !['autonomous','held'].includes(phase)) return;
 const db=await database('DB');
 if(!(await db.prepare('SELECT value FROM fixture_history WHERE id=?').bind(phase).first())) throw Error('Missing history');
 }`);
 await writeFile(file, JSON.stringify(surface));
 const positive = await verify(root);
 outcomes.push(positive.ok);
 for (const config of [declaration('REMOTE'), declaration('DB', 'UPDATE fixture_history SET value=?'), declaration('DB', 'INSERT INTO agent_door_audit(id) VALUES (?)')]) {
  surface.verification.history = config;
  await writeFile(file, JSON.stringify(surface));
  const result = await verify(root).catch(error => error);
  phases.push(result.points?.filter(point => !point.ok).map(point => point.detail));
  outcomes.push(result.code === 'agent_history_invalid' || result.points?.some(point => !point.ok && point.detail?.includes('agent_history_invalid')));
 }
 surface.verification.history = declaration();
 await writeFile(file, JSON.stringify(surface));
 await writeFile(join(root, 'dist/server/migrations/9999_trigger.sql'), "CREATE TRIGGER steal_history AFTER INSERT ON fixture_history BEGIN INSERT INTO agent_door_state(key,value) VALUES ('history','forged'); END;");
 const trigger = await verify(root).catch(error => error);
 outcomes.push(trigger.points?.some(point => !point.ok && point.detail?.includes('agent_history_invalid')));
 const hosted = await serveHosted(root);
 try {
  outcomes.push(await hosted.database('REMOTE').then(() => false, error => error.code === 'hosted_database_invalid'));
  const db = await hosted.database('DB');
  outcomes.push(await db.prepare('SELECT COUNT(*) AS n FROM fixture_history').first().then(row => row.n === 0));
 } finally { await hosted.close(); }
 assert.deepEqual(outcomes, Array(7).fill(true), JSON.stringify({ outcomes, phases, failures: positive.points.filter(point => !point.ok), trigger: trigger.points?.filter(point => !point.ok) }));
});

test('undeclared history leaves the native conformance results unchanged', { timeout: 120000 }, async t => {
 const { root, file, surface } = await seed(t);
 delete surface.verification.history;
 await writeFile(file, JSON.stringify(surface));
 await writeFile(join(root, 'tests/history.mjs'), 'throw Error("undeclared history executed");');
 const first = await verify(root), second = await verify(root);
 assert.deepEqual({ ok: second.ok, points: second.points.map(({ id, ok }) => ({ id: id.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, 'UUID'), ok })) }, { ok: true, points: first.points.map(({ id, ok }) => ({ id: id.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, 'UUID'), ok })) });
});
