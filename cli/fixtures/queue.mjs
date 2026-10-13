import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Public CLI cases own their admission state, even when the suite itself was
// admitted by a different queue. Keep real queue ownership and slot admission;
// these cases do not test the host's fluctuating load or free memory.
// Server lifecycle cases likewise own serving admission, with explicit refusal
// cases overriding their own limit.
export async function isolatedQueue(t, environment = process.env) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-cli-queue-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const env = { ...environment, RER_JOBS_DIR: directory, RER_SERVERS_DIR: environment.RER_SERVERS_DIR ?? join(directory, 'servers'), RER_JOBS_LOAD_THRESHOLD: '100000', RER_SERVERS_MIN_MEMORY_BYTES: '0', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0', RER_SERVERS_LOAD_THRESHOLD: '100000' };
 delete env.RER_JOB_POLICY;
 delete env.RER_JOB_MEMBERSHIP;
 return env;
}
