import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedQueue } from './fixtures/queue.mjs';
import { declaration, writeSizeSeed } from './fixtures/size-flows-seed.mjs';

// The last step of rer verify, through its own door (cli/size/verify-step.mjs, which lifecycle.mjs calls), and rer size
// in a checkout without a seedContract. Both run the size-flows seed: a built Worker with a scan that grows and a keyed read.
const run = promisify(execFile), rer = resolve(import.meta.dirname, '../bin/rer.mjs'), step = resolve(import.meta.dirname, 'size/verify-step.mjs');
const exec = (file, args, env = process.env) => run(process.execPath, [file, ...args], { env }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
const result = ({ stdout }) => stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.event === 'result');

const directories = [];
after(() => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));
const flowsOf = (...names) => ({ ...structuredClone(declaration), personas: { owner: { kind: 'owner' }, anonymous: { kind: 'anonymous' } }, flows: declaration.flows.filter(flow => names.includes(flow.name)) });
async function seed(shape) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-size-verify-'));
 directories.push(directory);
 return writeSizeSeed(directory, shape);
}

test('verify\'s size step fails exactly when rer size fails, naming the declared flow and its rule', { timeout: 300_000 }, async t => {
 const env = await isolatedQueue(t, process.env);
 const failing = await seed(flowsOf('scan', 'keyed'));
 const refused = await exec(step, [failing]);
 assert.equal(refused.code, 1, refused.stdout + refused.stderr);
 assert.match(refused.stderr, /Size check failed: 1 of 2 declared flows fail: scan \(growth\)/);
 assert.doesNotMatch(refused.stderr, /fail: .*keyed/);
 assert.equal((await exec(rer, ['size', '--cwd', failing], env)).code, 1);
 const passing = await seed(flowsOf('keyed'));
 const accepted = await exec(step, [passing]);
 assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
 assert.equal(JSON.parse(accepted.stdout).flows[0].name, 'keyed', 'the step returns what rer size --json carries, as verify\'s size');
 assert.equal((await exec(rer, ['size', '--cwd', passing], env)).code, 0);
});

// A trigger whose body reads a chain of 119 CTEs: 120 FROM items once expanded, over D1's 100.
const chain = n => `WITH c0 AS (SELECT id AS n FROM items), ${Array.from({ length: n }, (_, i) => `c${i + 1} AS (SELECT n FROM c${i})`).join(', ')} SELECT n FROM c${n}`;
const trigger = `CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN\n INSERT INTO filler(id) ${chain(119)};\nEND;\n`;

test('without a size-check.json verify\'s size step checks the schema objects and says the check is undeclared', { timeout: 120_000 }, async t => {
 const env = await isolatedQueue(t, process.env);
 const root = await seed(flowsOf('keyed'));
 await rm(join(root, 'size-check.json'));
 const outcome = await exec(step, [root]);
 assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
 assert.match(outcome.stderr, /Size check: undeclared \(no size-check\.json\)\./);
 assert.equal(JSON.parse(outcome.stdout).flows, undefined);
 assert.equal((await exec(rer, ['size', '--cwd', root], env)).code, 0);
 await writeFile(join(root, 'dist/server/migrations/0002_audit.sql'), trigger);
 const refused = await exec(step, [root]);
 assert.equal(refused.code, 1, refused.stdout + refused.stderr);
 assert.match(refused.stderr, /items_audit/);
});

// An OPERATIONS version 2 checkout with no seedContract whose build is not under dist/server, and whose declared `size`
// argv would write FORWARDED if rer ran it.
async function independent(shape, { owner = true } = {}) {
 const moved = 'out/server', root = await seed({ ...shape, build: { wrangler: `${moved}/wrangler.json`, deployDeclaration: 'config/deploy.json' } });
 await mkdir(join(root, moved), { recursive: true });
 await mkdir(join(root, 'config'), { recursive: true });
 for (const name of ['wrangler.json', 'index.js', 'migrations']) await rename(join(root, 'dist/server', name), join(root, moved, name));
 await rename(join(root, 'deploy.json'), join(root, 'config/deploy.json'));
 await writeFile(join(root, 'task.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('FORWARDED', '1');\n");
 const commands = Object.fromEntries(['size', 'verify'].map(verb => [verb, { argv: ['node', 'task.mjs'], inputs: ['task.mjs'], effects: 'Runs the independent project check.' }]));
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/independent', runtime: { requirements: [] }, requiredEnvironment: [], commands }));
 if (!owner) await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ fields: [], steps: [] }));
 return root;
}

test('in a checkout without a seedContract rer size runs its declared flows from build.wrangler, never forwards, and refuses an owner it cannot create', { timeout: 300_000 }, async t => {
 const env = await isolatedQueue(t, process.env);
 const root = await independent(flowsOf('scan', 'keyed', 'tick'));
 const outcome = await exec(rer, ['size', '--cwd', root, '--json'], env), size = result(outcome);
 assert.equal(outcome.code, 1, outcome.stdout + outcome.stderr);
 assert.deepEqual(size.flows.map(flow => [flow.name, flow.ok]), [['scan', false], ['keyed', true], ['tick', false]]);
 assert.equal(size.flows[1].large.status, 200, 'the owner persona signed in through the declared owner claim');
 await assert.rejects(access(join(root, 'FORWARDED')), { code: 'ENOENT' }, 'the declared size argv was not run');
 const bare = await independent(flowsOf('keyed'), { owner: false });
 const refused = await exec(rer, ['size', '--cwd', bare], env);
 assert.equal(refused.code, 1, refused.stdout + refused.stderr);
 assert.match(refused.stderr, /rer-setup\.json/);
 assert.match(refused.stderr, /agent-surface\.json/);
});
