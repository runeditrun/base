import { registerHooks } from 'node:module';
// Exercise the macOS credential boundary from Linux without changing application code.
if (process.env.TEST_MACOS_KEYCHAIN) Object.defineProperty(process, 'platform', { value: 'darwin' });
registerHooks({
 resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' && /\/cli\/business\/(keychain|service)\.mjs$/.test(context.parentURL ?? '')) {
   return { url: new URL('./process-edge.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
 },
});
