// A real live holder must remain reachable through the printed recovery argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');

test('capacity recovery uses the working launcher and the live holder in text and JSON', { timeout: 60000 }, async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-holder-recovery-')));
 const home = join(directory, 'home'), servers = join(directory, 'servers');
 await Promise.all([mkdir(home), mkdir(servers)]);
 t.after(() => rm(directory, { recursive: true, force: true }));
 for (const name of ['run-slate', "holder --cwd ' rer dev --stop folder"]) {
  const checkout = join(directory, name); await mkdir(checkout);
  const holder = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
   const port = Number(String((await once(holder.stdout, 'data'))[0]).trim());
   await writeFile(join(servers, 'state.json'), JSON.stringify({ version: 1, sequence: 0, queued: [], running: [{ checkout, mode: 'dev', port, limit: 1, explicit: true, owner: { pid: holder.pid } }] }));
   for (const detached of [false, true]) {
    const messages = [];
    for (const json of [false, true]) {
     const child = spawn(process.execPath, [join(base, 'global/rer.mjs'), 'dev', detached ? '--detach' : '--foreground', '--cwd', join(base, 'default-seed'), ...(json ? ['--json'] : [])], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, PWD: directory, OLDPWD: directory, TMPDIR: directory, RER_SERVERS_DIR: servers, RER_SERVER_LIMIT: '10', RER_INVOKED_AS: '/working bin/rer', RER_NODE_AUTO: '0', RER_NO_UPDATE_CHECK: '1', CI: 'true' },
     });
     t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
     let stdout = '', stderr = '';
     child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
     const [code] = await once(child, 'close');
     assert.equal(code, 4, stderr + stdout);
     const message = json ? stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'error')?.message : stderr.trimEnd();
     assert.ok(message.includes(checkout), 'the diagnostic retains the real holder');
     const commands = message.split('\n').filter(line => line.trimStart().startsWith("'/working bin/rer' dev") && line.includes('--cwd'));
     const targets = [];
     for (const command of commands) {
      const decoded = await run('/bin/sh', ['-c', 'set -- ' + command + '; printf "%s\\0" "$@"']);
      assert.equal(decoded.code, 0, decoded.stderr);
      const argv = decoded.stdout.split('\0').slice(0, -1), index = argv.indexOf('--cwd');
      assert.equal(argv[0], '/working bin/rer');
      if (argv[index + 1] === checkout) targets.push(argv);
     }
     assert.equal(targets.length, 2, 'both recovery commands target the live holder');
     assert.ok(targets.some(argv => argv.includes('--stop')));
     assert.ok(targets.some(argv => !argv.includes('--stop')));
     messages.push(message);
    }
    assert.equal(messages[0], messages[1]);
   }
  } finally {
   const closed = once(holder, 'exit'); holder.kill('SIGTERM'); await closed;
  }
 }
});
