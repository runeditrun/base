/** Credential-free workerd/D1 harness for the real, separately committed native app. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureProvider } from './provider.mjs';
import { completeFirstRun } from '../../../default-seed/tests/operator-auth/first-run.mjs';

export async function startNativeConsumer(root, evidence, installationId = 'compiled_native') {
  const provider = await fixtureProvider();
  let worker, log = '';
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  provider.state.allowed = origin;
  const persist = join(root, '.wrangler/compiled-native');
  const config = join(root, 'dist/server/wrangler.json');
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  const command = args => execFileSync('pnpm', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 20e6 });
  async function close() {
    if (worker && worker.exitCode === null) {
      const exited = new Promise(resolve => worker.once('exit', resolve));
      process.kill(-worker.pid, 'SIGTERM');
      await exited;
    }
    await provider.close();
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'native-worker.log'), log);
    await rm(persist, { recursive: true, force: true });
  }
  try {
    log += command(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'default-seed-reference', '--local', '--persist-to', persist, '--config', config]);
    log += command(['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', persist, '--config', config, '--file', join(root, 'tests/e2e/fixtures.sql')]);
    worker = spawn('pnpm', ['exec', 'wrangler', 'dev', '--inspector-port', '0', '--config', config, '--local', '--persist-to', persist,
      '--show-interactive-dev-session=false', '--ip', '127.0.0.1', '--port', String(port),
      '--var', 'OWNER_EMAIL:operator@example.test', '--var', 'SETUP_TOKEN:editor-test-only-bootstrap-token-32-bytes',
      '--var', 'SESSION_SECRET:editor-test-only-session-secret-32-bytes', '--var', `AUTH_ORIGIN:${origin}`, '--var', 'AUTH_LOCAL:true',
      '--var', `EDITOR_MANAGEMENT_ORIGIN:${provider.origin}`, '--var', `EDITOR_INSTALLATION_ID:${installationId}`],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout.on('data', chunk => { log += chunk; });
    worker.stderr.on('data', chunk => { log += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      assert.equal(worker.exitCode, null, log);
      try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'workerd health listener did not start');
    const bootstrap = await fetch(origin + '/auth/bootstrap', { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'editor-test-only-bootstrap-token-32-bytes', displayName: 'Editor test owner' }) });
    assert.equal(bootstrap.status, 303, 'native bootstrap must create the owner session');
    await completeFirstRun(origin, bootstrap.headers.get('set-cookie').split(';')[0]);
    const [name, value] = bootstrap.headers.get('set-cookie').split(';')[0].split('=');
    const login = async page => page.context().addCookies([{ name, value, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    return { origin, provider, close, port, login };
  } catch (error) { await close(); throw error; }
}
