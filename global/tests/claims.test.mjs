// Processes claiming one port or one launch at the same moment: exactly one
// wins and every other finds a live holder. Eight claimers stay alive (so each
// claim stays live) and, round after round, claim the same fresh port and then
// the same fresh launch directory together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const claimer = `
import { createInterface } from 'node:readline';
import { claimLaunch, claimPort } from ${JSON.stringify(new URL('../launch/state.mjs', import.meta.url).href)};
console.log('ready');
for await (const line of createInterface({ input: process.stdin })) {
 const [kind, value] = line.split(' ');
 console.log(kind === 'port' ? Boolean(await claimPort(Number(value))) : await claimLaunch(value, String(process.pid)));
}
`;

test('processes racing for one port or one launch get exactly one winner', { timeout: 120_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-claims-'));
 const env = { PATH: process.env.PATH, HOME: process.env.HOME, RER_SERVERS_DIR: join(directory, 'servers') };
 const claimers = Array.from({ length: 8 }, () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', claimer], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, next: async () => (await lines.next()).value };
 });
 t.after(async () => {
  for (const { child } of claimers) child.kill();
  await rm(directory, { recursive: true, force: true });
 });
 for (const claimer of claimers) assert.equal(await claimer.next(), 'ready');
 const race = async command => {
  for (const { child } of claimers) child.stdin.write(command + '\n');
  return (await Promise.all(claimers.map(claimer => claimer.next()))).filter(answer => answer === 'true').length;
 };
 for (let round = 0; round < 40; round++) {
  assert.equal(await race(`port ${20000 + round}`), 1, `one claimer holds port ${20000 + round}`);
  const launch = join(directory, `launch-${round}`);
  await mkdir(launch);
  assert.equal(await race(`launch ${launch}`), 1, `one claimer holds launch ${round}`);
 }
});
