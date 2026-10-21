// Adopters bundle the public Worker entry from the actual rer archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildPackage } from '../scripts/rer-package.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { runtime, source, mapping, targets } from '../modules/import-kit/tests/d1/fixtures.ts';

const base = resolve(import.meta.dirname, '..');
const { build } = createRequire(join(base, 'default-seed/package.json'))('esbuild');

test('packed D1 public entry supports reviewed conversion and preserved reversal', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-import-kit-package-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const bytes = await readFile(await buildPackage(base, join(root, 'built')));
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), join(root, 'node_modules/@runeditrun/rer'));
 const bundled = await build({
  absWorkingDir: root, stdin: { contents: "export * from '@runeditrun/rer/modules/import-kit/d1';", resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
 });
 const kit = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
 const r = await runtime(t);
 const adapter = { ...targets, async preparePreservedUndo(db, destination, effects) {
  const rows = await targets.list(db, destination);
  return {
   observations: effects.map(effect => ({ effectId: effect.provenance.id, current: rows.find(row => row.targetId === effect.expected.targetId && row.targetKind === effect.expected.targetKind) ?? null })),
   dependencies: [], guards: [targets.matchesCount(rows.length, destination), ...rows.map(row => targets.matches(row, destination, row.targetKind, row.targetId))],
  };
 } };
 const context = { ...r.context(), storage: { database: r.db(), targets: adapter } };
 const plan = await kit.planD1Import(source(1), mapping, context);
 const job = await kit.createD1ImportJob(plan, { ...context, reviewedFingerprint: plan.fingerprint });
 assert.equal((await kit.resumeD1Import(job.id, context)).state, 'completed');
 const review = await kit.previewD1PreservedUndo(job.id, context);
 await kit.convertD1ReversalPolicy(job.id, context, { to: 'preserve-conflicts', reviewedFingerprint: review.reviewedFingerprint });
 await assert.rejects(() => kit.convertD1ReversalPolicy(job.id, context, { to: 'preserve-conflicts', reviewedFingerprint: review.reviewedFingerprint }), error => error instanceof kit.D1ReversalPolicyConversionError && error.code === 'IMPORT_CONVERSION_ALREADY_CONVERTED');
 await kit.undoD1Import(job.id, context);
 assert.equal((await kit.readD1ImportUndoReport(job.id, context)).outcome, 'undone');
 assert.deepEqual(await targets.list(r.db(), context.destination), []);
});
