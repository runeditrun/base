import { registerHooks } from 'node:module';
registerHooks({
 resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' && /\/cli\/business\/(keychain|service)\.mjs$/.test(context.parentURL ?? '')) {
   return { url: new URL('./process-edge.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
 },
});
