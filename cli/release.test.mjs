import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportCLI } from './export.mjs';
import { fixture } from '../modules/release/test-fixture.mjs';
import { contractText } from '../modules/release/contract-fixture.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
const base=resolve(import.meta.dirname,'..');

test('exported release dispatcher preserves local producer receipts, flags and exits',async t=>{
 const env=await isolatedQueue(t);
 const f=fixture(t),portable=join(f.temporary,'portable');
 await exportCLI(base,portable);await cp(join(base,'onboarding'),join(portable,'scripts/base-onboarding'),{recursive:true});
 const invoke=args=>spawnSync(process.execPath,[join(portable,'scripts/rer.mjs'),'release','--repo',f.repo,'--project','just-every/run-lamp','--repository','https://github.com/just-every/run-lamp','--output',f.options.output,...args],{cwd:portable,env,encoding:'utf8',timeout:120000});
 // A contract with no published clause is refused with its own message; the same clause as a heading releases.
 const clause={id:'TEST-001',title:'Exact bytes',body:'Export the verified committed bytes.'};
 await writeFile(join(f.repo,'CONTRACT.md'),contractText([{...clause,kind:'target'}]));const unpublished=f.commit();
 const refused=invoke(['--dry-run','--ref',unpublished]);assert.equal(refused.status,2);assert.match(refused.stderr,/CONTRACT\.md must contain published clauses/);
 await writeFile(join(f.repo,'CONTRACT.md'),contractText([{...clause,form:'heading'}]));const headed=f.commit();
 const success=invoke(['--dry-run','--ref',headed]);assert.equal(success.status,0,success.stderr);const receipt=JSON.parse(success.stdout);assert.equal(receipt.status,'DRY_RUN');assert.equal(receipt.gates.verify.passed,1);assert.equal(receipt.tag.created,false);assert.equal(receipt.tag.pushed,false);
 assert.equal(JSON.parse(await readFile(join(f.options.output,receipt.siteRelease.path),'utf8')).provenance.publication,'dry-run');
 const invalid=invoke(['--unknown']);assert.equal(invalid.status,2);
 const blocked=fixture(t,'node -e "process.exit(7)"');f.repo=blocked.repo;f.options.output=blocked.options.output;
 const failed=invoke(['--dry-run']);assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).gates.verify.exitCode,7);
});
