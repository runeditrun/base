import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('../../modules/import-kit/', import.meta.url);
const prefix = `rer-receipt:${Buffer.from(root.href).toString('base64url')}/`;
const allowed = path => /^src\/(receipt|status)\/[^/]+\.ts$/.test(path);
let loaded;

/** Load the maintained TypeScript implementation unchanged, including from an
 * npm installation. Native stripping refuses file URLs under node_modules;
 * scoped virtual URLs let Node's same type stripper load just this API graph.
 * No generated signer copy, external transpiler or application loader is used.
 */
export function loadReceiptApi() {
 return loaded ??= load();
}

async function load() {
 const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
   if (specifier === prefix + 'src/receipt/index.ts') return { url: specifier, shortCircuit: true };
   if (context.parentURL?.startsWith(prefix)) {
    const url = new URL(specifier, new URL(context.parentURL.slice(prefix.length), root));
    const path = url.href.slice(root.href.length);
    if (url.href.startsWith(root.href) && allowed(path)) return { url: prefix + path, shortCircuit: true };
    return nextResolve(url.href, context);
   }
   return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
   if (url.startsWith(prefix) && allowed(url.slice(prefix.length))) {
    return { format: 'module-typescript', source: readFileSync(new URL(url.slice(prefix.length), root), 'utf8'), shortCircuit: true };
   }
   return nextLoad(url, context);
  },
 });
 try { return await import(prefix + 'src/receipt/index.ts'); }
 finally { hook.deregister(); }
}
