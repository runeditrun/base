import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workerEngine } from '../container/worker-engine.mjs';
import { sealTemplate } from './template.mjs';

/** Migrate with the packaged engine; never dispatch an app request or claim. */
export async function prepareTemplate({ root = '/app', data = '/template' } = {}) {
 const manifest = JSON.parse(await readFile(join(root, 'container.json'), 'utf8'));
 if (manifest.engine !== 'workerd') throw new Error('demo-template-requires-workerd');
 await mkdir(data, { mode: 0o700 });
 let engine;
 try {
  engine = await workerEngine({ root, data, manifest, settings: { RER_DEMO: '1' } });
 } finally {
  await engine?.close();
 }
 return sealTemplate(data, manifest);
}

if (process.argv[1] === import.meta.filename) {
 try { await prepareTemplate(); }
 catch (error) {
  // A failed engine constructor may still own workerd handles. The build must
  // fail immediately; there is no usable template to keep alive or recover.
  console.error('Demo template preparation failed:', error.name);
  process.exit(1);
 }
}
