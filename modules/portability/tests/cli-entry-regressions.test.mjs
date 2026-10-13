import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile);
test('CLI entry detection follows filesystem aliases instead of silently doing nothing',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'portability-cli-entry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const entry=join(directory,'entry.mjs');await symlink(fileURLToPath(new URL('../cli.mjs',import.meta.url)),entry);
  await assert.rejects(execute(process.execPath,[entry,'export','--origin','http://example.test','--session-file',join(directory,'session'),
    '--out',join(directory,'archive')]),error=>error.code===1 && /Transfer failed/.test(error.stderr));
});
