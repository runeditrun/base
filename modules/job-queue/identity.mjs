import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, unlink } from 'node:fs/promises';
import { processInfo } from './processes.mjs';

// A lifetime nonce supplements Darwin's second-resolution ps start time.
// It also distinguishes two library clients in the same Node process.
export async function identity() {
  const token = randomUUID(), socket = join(tmpdir(), `rer-job-${token}.sock`);
  // Darwin's TMPDIR can be long; use the short system temporary directory then.
  const path = Buffer.byteLength(socket) < 100 ? socket : `/tmp/rer-job-${token}.sock`;
  // A prober that timed out or exited may close before the answer is written;
  // the prober reports that itself, so the answer's EPIPE or ECONNRESET is dropped.
  const server = createServer(client => { client.on('error', () => {}); client.end(token); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  const { title, ...processIdentity } = await processInfo(process.pid);
  const info = { ...processIdentity, token, socket: path };
  return { info, async close() {
    await new Promise(resolve => server.close(resolve));
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

export async function alive(owner, inspection) {
  const current = await processInfo(owner.pid, inspection);
  if (!current || current.zombie || current.start !== owner.start) return false;
  if (!owner.socket || !owner.token) throw Error('Lease lacks lifetime identity');
  return new Promise((resolve, reject) => {
    const connection = createConnection(owner.socket);
    let body = '';
    connection.setTimeout(3000, () => connection.destroy(Object.assign(Error('Owner identity probe timed out'), { code: 'PROBE_TIMEOUT' })));
    connection.on('data', data => { body += data; if (body.length > 128) connection.destroy(Error('Invalid owner identity')); });
    connection.on('end', () => resolve(body === owner.token));
    connection.on('error', async error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else if (['ECONNRESET', 'PROBE_TIMEOUT'].includes(error.code)) {
        // Listener shutdown can reset a probe after the initial PID check, and a
        // busy owner can answer late. Neither proves death: reclaim only a process
        // that is gone; otherwise retain the owner until the next sample.
        try {
          const after = await processInfo(owner.pid, inspection);
          resolve(Boolean(after && !after.zombie && after.start === owner.start));
        } catch (failure) { reject(failure); }
      }
      else reject(error);
    });
  });
}
