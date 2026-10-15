import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../index.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const consumer = join(root, 'default-seed');
export const fixtureScript = fileURLToPath(new URL('./fixture-seed/server.mjs', import.meta.url));
export const syntheticSecret = 'synthetic-rendered-credential';
export async function temporary(t, prefix = 'review-harness-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'review-harness-'));
  const { args = [], ...extras } = options;
  let runtime;
  try { runtime = await startRuntime({ cwd: root, command: process.execPath, args: [fixtureScript, '--port', '{PORT}', ...args], logDir: join(directory, 'logs'), readyTimeoutMs: 30_000, ...extras }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  t.after(async () => { try { await runtime.stop(); } finally { await rm(directory, { recursive: true, force: true }); } });
  return { ...runtime, directory, evidence: resolve(directory, 'evidence') };
}
export async function openSignIn(page) {
  await page.goto('/signin');
  return page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href');
}
