import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory } from './files.mjs';
import { redact } from './privacy.mjs';
import { spawnOwnedProcess, stopOwnedProcess } from './process.mjs';
import { abortable } from './cancellation.mjs';

async function assertLoopbackOnly(port) {
  const addresses = new Set(Object.values(networkInterfaces()).flat().filter(info => info && !info.internal && info.family === 'IPv4').map(info => info.address));
  for (const host of addresses) await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Cannot confirm loopback-only listener')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Runtime listener is exposed outside 127.0.0.1')); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Loopback listener inspection timed out')); });
  });
}

export async function startRuntime({ cwd, command, args = [], env = {}, healthPath = '/health', readyTimeoutMs = 120_000, logDir, secrets = [], fixtures, stopTimeoutMs = 10_000, signal }) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) throw new TypeError('readyTimeoutMs must be positive');
  let origin, port, receiptError;
  // The serving process owns allocation. No socket is released for it to rebind.
  function receipt(line) {
    if (!line.startsWith('RER_READY ')) return;
    try {
      const address = new URL(line.slice('RER_READY '.length).trim());
      const reportedPort = Number(address.port);
      if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || reportedPort <= 0 || reportedPort > 65535 || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('Invalid runtime readiness address');
      if (origin && address.origin !== origin) throw new Error('Runtime changed its readiness address');
      origin = address.origin; port = reportedPort;
    } catch (error) { receiptError = error; }
  }
  const root = await privateDirectory(resolve(logDir ?? join(cwd, '.review-logs')));
  const directory = await mkdtemp(join(root, 'runtime-'));
  await privateDirectory(directory);
  const temporary = await privateDirectory(join(directory, 'tmp'));
  const logPath = join(directory, 'runtime.log');
  const log = await open(logPath, 'wx', 0o600);
  let writes = Promise.resolve(), owned, stopped;
  const onAbort = () => { void stop().catch(() => {}); }; // The start/stop caller awaits this same cleanup promise.
  function record(text) { writes = writes.then(() => log.writeFile(redact(text, secrets))); }
  function capture(stream, inspectReceipt = false) {
    const decoder = new StringDecoder('utf8');
    let pending = '', readyPending = '';
    const keep = Math.max(0, ...secrets.map(value => value.length));
    stream.on('data', chunk => {
      const decoded = decoder.write(chunk);
      if (inspectReceipt) {
        readyPending += decoded;
        let end;
        while ((end = readyPending.indexOf('\n')) >= 0) { receipt(readyPending.slice(0, end)); readyPending = readyPending.slice(end + 1); }
        if (readyPending.length > 65536) { receiptError = new Error('Runtime readiness line is too long'); readyPending = ''; }
      }
      pending += decoded;
      const searchAt = pending.length - keep - 1;
      const end = searchAt >= 0 ? pending.lastIndexOf('\n', searchAt) : -1;
      if (end >= 0) { record(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    });
    stream.on('end', () => { record(pending + decoder.end()); pending = ''; });
  }
  async function stop() {
    return stopped ??= (async () => {
      signal?.removeEventListener('abort', onAbort);
      try { await stopOwnedProcess(owned, stopTimeoutMs); }
      finally { try { await writes; await log.close(); } finally { await rm(temporary, { recursive: true, force: true }); } }
    })();
  }
  try {
    signal?.throwIfAborted();
    const substitutions = value => {
      if (value.includes('{ORIGIN}')) throw new TypeError('Runtime origin is available after the listener reports RER_READY');
      return value.replaceAll('{PORT}', '0');
    };
    owned = spawnOwnedProcess(command, args.map(substitutions), {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: process.env.CI ?? 'true', ...env,
        TMPDIR: temporary, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    capture(owned.child.stdout, true); capture(owned.child.stderr);
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = performance.now() + readyTimeoutMs;
    let ready = false;
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      if (owned.state.error || owned.state.exited) throw new Error(`Runtime exited before ready (exit=${owned.state.code})`);
      if (receiptError) throw receiptError;
      if (!origin) {
        await delay(Math.min(50, Math.max(0, deadline - performance.now())), undefined, { signal });
        continue;
      }
      const health = new URL(healthPath, origin);
      if (health.origin !== origin) throw new TypeError('Health path must be same-origin');
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now()))));
        const response = await fetch(health, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        ready = response.status === 200;
        await response.body?.cancel();
      } catch { /* A loopback server may still be starting. */ }
      signal?.throwIfAborted();
      if (receiptError) throw receiptError;
      if (ready) break;
      await delay(Math.min(50, Math.max(0, deadline - performance.now())), undefined, { signal });
    }
    if (!ready) throw new Error('Runtime health timed out');
    if (owned.state.error || owned.state.exited) throw new Error('Runtime exited before ready');
    await assertLoopbackOnly(port);
    await abortable(() => fixtures?.(origin, signal), signal);
    signal?.throwIfAborted();
    if (receiptError) throw receiptError;
    if (owned.state.error || owned.state.exited) throw new Error('Runtime exited during fixtures');
    return { origin, port, logPath, pid: owned.state.pid, stop };
  } catch (error) {
    try { await stop(); }
    catch { throw new Error(`Runtime start and cleanup failed; private log: ${logPath}`); }
    throw new Error(`${redact(error.message, secrets)}; private log: ${logPath}`);
  }
}
