import {writeTestManifest, manifestContract} from './test-manifest-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createState } from './state.mjs';
import { startInstaller } from './server.mjs';
import { createModel } from './ui/model-core.mjs';

const fields = { TITLE: { valid: value => typeof value === 'string' }, REGION: { valid: value => typeof value === 'string' } };
const seed = {
 product: 'Answer provenance', model: { fields, safeKeys: ['TITLE', 'REGION'] },
 defaults: () => ({ REGION: 'suggested-REGION' }), validateInput: value => value,
 install: async (_root, _input, store) => store.phase('complete'),
};
const model = createModel({ ...seed.model, product: { name: seed.product }, setupGroups: [{ id: 'details', keys: ['TITLE', 'REGION'] }] });
async function directory(t) {
 const root = await mkdtemp(join(tmpdir(), 'answer-provenance-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeTestManifest(root,[{name:'TITLE',label:'Title',kind:'text'},{name:'REGION',label:'Region',kind:'text'}]);
 return root;
}
async function client(root, options = {}) {
 const server = await startInstaller(root, { seed:manifestContract(seed), ...options });
 const page = await fetch(server.origin), html = await page.text();
 const headers = { Origin: server.origin, Cookie: page.headers.get('set-cookie').split(';')[0], 'X-Installer-Token': html.match(/name="installer-token" content="([a-f0-9]+)"/)[1], 'Content-Type': 'application/json' };
 return { server, post: (path, input) => fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify(input) }) };
}

for (const source of ['browser', 'agent']) test(`a partial ${source} answer leaves unrelated suggestions unanswered through resume`, async t => {
 const root = await directory(t), store = await createState(root, seed);
 t.after(() => store.closeCommands());
 store.state.draft = seed.defaults();
 await store.draft({ ...store.state.draft, TITLE: 'Owner TITLE' }, source, ['TITLE']);
 assert.deepEqual(store.state.answered, ['TITLE']);
 assert.deepEqual(model.summaryKeys(store.state.draft, store.state), ['TITLE']);
 await store.draft({ ...store.state.draft }, source, []);
 assert.deepEqual(store.state.answered, ['TITLE']);
 assert.deepEqual(JSON.parse(await readFile(join(root, '.seed/installer/state.json'), 'utf8')).answered, ['TITLE']);
 const resumed = await createState(root, seed); t.after(() => resumed.closeCommands());
 assert.deepEqual(resumed.state.draft, { TITLE: 'Owner TITLE', REGION: 'suggested-REGION' });
 assert.deepEqual(resumed.state.answered, ['TITLE']);
 assert.deepEqual(model.summaryKeys(resumed.state.draft, resumed.state), ['TITLE']);
});

test('an explicitly empty persisted answer set stays empty and legacy owner answers survive', async t => {
 const root = await directory(t), path = join(root, '.seed/installer/state.json');
 await mkdir(join(root, '.seed/installer'), { recursive: true });
 for (const saved of [{ answered: [] }, {}]) {
  await writeFile(path, JSON.stringify({ product: seed.product, draft: { TITLE: 'Saved detail', REGION: 'Saved REGION', unknown: 'ignored' }, ...saved }));
  const store = await createState(root, seed);
  try { assert.deepEqual(store.state.answered, 'answered' in saved ? [] : ['TITLE', 'REGION']); }
  finally { await store.closeCommands(); }
 }
});

test('API draft saves only submitted answers, resume retains them, and Start approves the full input', async t => {
 const root = await directory(t); let session = await client(root);
 t.after(() => session.server.close());
 assert.deepEqual(model.summaryKeys(session.server.state.draft, session.server.state), []);
 assert.equal((await session.post('/api/draft', { TITLE: 'Owner TITLE' })).status, 200);
 assert.deepEqual(session.server.state.lastUpdate.keys, ['TITLE']);
 assert.deepEqual(session.server.state.answered, ['TITLE']);
 assert.deepEqual(model.summaryKeys(session.server.state.draft, session.server.state), ['TITLE']);
 await session.server.close(); session = await client(root, { resume: true });
 assert.deepEqual(session.server.state.answered, ['TITLE']);
 assert.deepEqual(model.summaryKeys(session.server.state.draft, session.server.state), ['TITLE']);
 assert.equal((await session.post('/api/start', { TITLE: 'Owner TITLE', REGION: 'suggested-REGION' })).status, 202);
 await session.server.close();
 assert.equal(session.server.state.phase, 'complete');
 assert.deepEqual(session.server.state.answered, ['TITLE', 'REGION']);
});
