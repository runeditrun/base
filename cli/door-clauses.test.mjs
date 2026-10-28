import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportCLI } from './export.mjs';
import { parseContract } from '../foundation/runtime/seed-contract.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';

// One authoring journey, through the public launcher and the delivered seed CLI.
test('door clauses syncs canonical requirements without changing seed clauses or judgments', async t => {
 const base = resolve(import.meta.dirname, '..'), directory = mkdtempSync(join(tmpdir(), 'rer-door-clauses-'));
 t.after(() => rmSync(directory, { recursive: true, force: true }));
 const root = join(directory, 'seed with spaces');
 cpSync(join(base, 'foundation/fixtures/contract-docs/standard'), root, { recursive: true });
 mkdirSync(join(root, 'src/base'), { recursive: true });
 for (const file of ['contract-docs.mjs', 'seed-contract.mjs']) cpSync(join(base, 'foundation/runtime', file), join(root, 'src/base', file));
 cpSync(join(base, 'default-seed/OPERATIONS.json'), join(root, 'OPERATIONS.json'));
 writeFileSync(join(root, 'AGENTS.md'), 'Lander-Regenerate: node src/base/contract-docs.mjs write\nLander-Regenerate: node scripts/edition-authoring/cli.mjs lock\n');
 const file = join(root, 'CONTRACT.md'), read = name => readFileSync(join(root, name), 'utf8');
 // CRLF, Unicode, a seed-owned AGENT clause and a SURFACE clause all survive.
 let initial = read('CONTRACT.md').replace('## Field proof register', '#### AGENT-001 — Studio assistant\n\n*Tier:* Agent surface\n\n**Requirement.** The studio retains its own assistant.\n\n**Acceptance.**\n1. The assistant names its studio.\n\n## Field proof register') + '| `AGENT-001` | Studio assistant | target | missing | | Seed-owned gap — retain it. |\n';
 writeFileSync(file, initial.replaceAll('\n', '\r\n'));
 const env = { ...process.env, RER_UPDATE_CHECK: '0' };
 const invoke = (entry, args) => {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
 };
 // Set up generated views using the same real generator used by the command.
 const prepared = spawnSync(process.execPath, ['src/base/contract-docs.mjs', 'write'], { cwd: root, env, encoding: 'utf8' });
 assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
 initial = read('CONTRACT.md');
 const before = parseContract(initial), seedClauses = before.clauses.map(clause => ({ ...clause }));
 const source = readFileSync(join(base, 'modules/agent-door/CLAUSES.md'), 'utf8');
 const copied = 'src/base/modules/agent-door/CLAUSES.md';
 mkdirSync(join(root, 'src/base/modules/agent-door'), { recursive: true });
 writeFileSync(join(root, copied), source);
 const record = { schemaVersion: 1, copies: [{ path: 'src/base/modules/agent-door', originPath: 'modules/agent-door', revision: 'a'.repeat(40), files: { [copied]: createHash('sha256').update(source).digest('hex') } }] };
 writeFileSync(join(root, 'base-copies.json'), JSON.stringify(record));
 await exportCLI(base, root);
 const run = (...args) => invoke(join(base, 'global/rer.mjs'), ['door', 'clauses', '--cwd', root, ...args]);
 const badFlags = run('--write', '--check');
 assert.equal(badFlags.status, 2, badFlags.output);
 const missing = run('--check');
 assert.equal(missing.status, 1, missing.output);
 for (let n = 1; n <= 13; n++) assert.match(missing.output, new RegExp(`BASE-AGENT-${String(n).padStart(3, '0')} missing`));
 assert.equal(read('CONTRACT.md'), initial, 'check changes no contract bytes');
 const surface = JSON.parse(readFileSync(join(base, 'default-seed/agent-surface.json'), 'utf8'));
 const absent = validateAgentSurface(surface, { contract: initial }).points.filter(point => !point.ok && point.detail?.includes('absent from CONTRACT.md'));
 assert.ok(absent.some(point => point.detail.includes('BASE-AGENT-010')));
 const written = run('--write');
 assert.equal(written.status, 0, written.output);
 const synced = read('CONTRACT.md'), after = parseContract(synced);
 assert.equal(after.counts.total, before.counts.total + 13);
 assert.equal(after.counts.missing, before.counts.missing + 13);
 assert.equal(after.commit, before.commit);
 for (const clause of seedClauses) {
  const actual = after.clauses.find(item => item.id === clause.id);
  for (const key of ['title', 'text', 'kind', 'status', 'evidence', 'gap']) assert.deepEqual(actual[key], clause[key], `Preserve ${clause.id}.${key}`);
 }
 // Removing only the inserted area, new Status rows and generated summary
 // rows must recover every other byte, including CRLF and unrelated prose.
 const unchanged = text => text.replace(/### Agent surface \(Base-delivered\)[\s\S]*?(?=### Agent surface\r?\n)/, '').replace(/^\| `BASE-AGENT-\d{3}`[^\n]*\n/gm, '').replace(/^\| (Published|Target and push further|All) \|[^\n]*\n/gm, '');
 assert.equal(unchanged(synced), unchanged(initial));
 assert.deepEqual(validateAgentSurface(surface, { contract: synced }).points.filter(point => !point.ok), []);
 { const checked = run('--check'); assert.equal(checked.status, 0, checked.output); }
 const snapshot = () => ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md'].map(read);
 const stable = snapshot();
 assert.equal(run('--write').status, 0);
 assert.deepEqual(snapshot(), stable, 'second write leaves an empty diff');
 // A stale requirement and a newer seed judgment are independent edits.
 const row = synced.split(/\r?\n/).find(line => line.startsWith('| `BASE-AGENT-010`'));
 const judged = row.replace('| missing | |', '| partial | `README.md` |').replace("Not yet judged through this seed's own doors.", 'Webhook delivery remains unproved.');
 writeFileSync(file, synced.replace(row, judged).replace('**Requirement.** The seed emits a typed event', '**Requirement.** An older requirement emits a typed event'));
 const stale = run('--check');
 assert.equal(stale.status, 1, stale.output);
 assert.match(stale.output, /BASE-AGENT-010 stale/);
 assert.equal(run('--write').status, 0);
 assert.ok(read('CONTRACT.md').includes(judged), 'retain status, evidence and gap verbatim');
 { const checked = run('--check'); assert.equal(checked.status, 0, checked.output); }
 const edited = snapshot();
 assert.equal(run('--write').status, 0);
 assert.deepEqual(snapshot(), edited);
 writeFileSync(join(root, copied), source + '\nlocal drift\n');
 const drift = run('--write');
 assert.equal(drift.status, 1, drift.output);
 assert.match(drift.output, /local edits/);
 assert.deepEqual(snapshot(), edited);
 writeFileSync(join(root, copied), source);
 // Older runtime pins and seeds without a copy use the CLI's own inventory.
 record.copies[0].files = {};
 writeFileSync(join(root, 'base-copies.json'), JSON.stringify(record));
 { const checked = run('--check'); assert.equal(checked.status, 0, checked.output); }
 rmSync(join(root, 'base-copies.json'));
 { const checked = run('--check'); assert.equal(checked.status, 0, checked.output); }
 t.diagnostic(`Fixture clauses: ${before.counts.total} -> ${after.counts.total}; missing-clause errors: ${absent.length} -> 0; second write: empty diff; newer partial judgment retained.`);
});
