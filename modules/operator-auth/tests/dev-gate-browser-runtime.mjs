import { createRequire } from 'node:module';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySql } from './apply-sql.mjs';
import { DEV_KEY, OWNER, SECRET, read } from './dev-runtime.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = await readdir(join(root, 'node_modules/.pnpm'));
const wrangler = packages.find(name => name.startsWith('wrangler@4.129.1_'));
if (!wrangler) throw new Error('Install the frozen workspace dependencies before running auth browser tests.');
const require = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
export const { chromium } = createRequire(join(root, 'default-seed/package.json'))('@playwright/test');
export { DEV_KEY, OWNER };

export async function browserRuntime() {
  const output = await build({ entryPoints: [fileURLToPath(new URL('./dev-gate-browser-worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const directory = await mkdtemp(join(tmpdir(), 'operator-auth-dev-browser-'));
  const config = { origin: 'http://127.0.0.1', local: true, OWNER_EMAIL: OWNER, SESSION_SECRET: SECRET,
    MAIL_FROM: 'auth@example.com', ipLimit: 1000, emailLimit: 1000 };
  const options = (port = 0) => ({
    ...convertV4MiniflareOptions({ host: '127.0.0.1', port, modules: true, script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-01', d1Databases: { DB: 'dev-browser-auth' },
      bindings: { TEST_CONFIG: JSON.stringify(config), RER_DEV_KEY: DEV_KEY, AUTH_ORIGIN: config.origin, AUTH_LOCAL: 'true' } }),
    resourcePersistencePath: join(directory, 'state'),
  });
  const mf = new Miniflare(options());
  try {
    const address = await mf.ready;
    config.origin = address.origin;
    await mf.setOptions(options(Number(address.port)));
    await mf.ready;
    const db = await mf.getD1Database('DB');
    await applySql(db, await read('../accounts/schema/operator-auth.sql'));
    await db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner',?,'Owner','owner','active',1)").bind(OWNER).run();
    return { origin: config.origin, db,
      async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
