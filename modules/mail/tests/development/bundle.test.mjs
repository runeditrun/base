import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('actual reference Vite bundler imports sender and doctor without ineffective dynamic imports', async () => {
  const reference = createRequire(new URL('../../../../default-seed/package.json', import.meta.url));
  const { build } = await import(pathToFileURL(reference.resolve('vite')).href);
  const warnings = [];
  const result = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false,
    lib: { entry: fileURLToPath(new URL('./bundle-entry.mjs', import.meta.url)), formats: ['es'] },
    rolldownOptions: { onwarn(warning) { warnings.push(warning); } },
  } });
  assert.ok((Array.isArray(result) ? result : [result]).some(output => output.output.some(chunk => chunk.type === 'chunk' && chunk.code.includes('createMailSender') && chunk.code.includes('mailDoctor'))));
  assert.deepEqual(warnings.filter(warning => warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' || /dynamically imported.*statically imported/s.test(warning.message)), []);
});
