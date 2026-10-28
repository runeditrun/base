import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from '../../../container/adapters/d1-workerd.mjs';

const require = createRequire(new URL('../../../../default-seed/package.json', import.meta.url));
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { build } = wranglerRequire('esbuild');
const { values } = parseArgs({ options: { port: { type: 'string' }, 'health-delay': { type: 'string', default: '0' }, external: { type: 'string', default: 'http://127.0.0.1:1' } } });
const output = await build({ entryPoints: [new URL('./worker.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: Number(values.port), cf: false, telemetry: { enabled: false }, unsafeLocalExplorer: false, modules: true, script: output.outputFiles[0].text,
  compatibilityDate: '2026-09-01', d1Databases: { DB: 'review-fixture' }, bindings: { HEALTH_AFTER: String(Date.now() + Number(values['health-delay'])), EXTERNAL: values.external, SYNTHETIC_SECRET: 'synthetic-rendered-credential' } }));
let closing;
async function stop() { return closing ??= (async () => { await mf.dispose(); process.exitCode = 0; })(); }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stop().catch(() => { process.exitCode = 1; }); });
try {
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE fixture_setup(value TEXT)').run();
  const address = await mf.ready;
  console.log(`RER_READY ${address.origin}`);
} catch { await stop(); throw new Error('Synthetic Worker failed to start'); }
