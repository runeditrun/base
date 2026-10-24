/** Creates a separate committed default-seed consumer; never edits the canonical seed. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const base=fileURLToPath(new URL('../../..',import.meta.url));
const output=resolve(process.argv[2] || '');
if(!process.argv[2] || existsSync(output))throw new Error('Pass a new empty consumer directory');
mkdirSync(output,{recursive:true});
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:base,encoding:'utf8'}).trim();
execFileSync('tar',['-x','-C',output],{input:execFileSync('git',['archive','HEAD','default-seed','foundation/runtime','modules/operator-auth','modules/business-settings','modules/dependencies','modules/owner-claim','modules/demo','modules/mail','modules/ai','modules/portability','modules/d1-transport','modules/erasure','modules/import-kit/src','modules/import-kit/schema','modules/editor/src','onboarding'],{cwd:base,maxBuffer:20e6})});
cpSync(join(output,'modules/editor/src'),join(output,'default-seed/src/editor'),{recursive:true});
const seed=join(output,'default-seed');
const change=(file,from,to)=>{const path=join(seed,file),text=readFileSync(path,'utf8');if(!text.includes(from))throw new Error(`Missing source marker: ${file}`);writeFileSync(path,text.replace(from,to));};
change('src/core/app/hono.ts',"import { sessionForRequest }","import { sessionForRequest, operatorAuth }");
change('src/core/app/hono.ts',"  app.get('/api/public/feed'",`  app.get('/api/editor/config', async (context) => {
    context.header('cache-control', 'no-store, private')
    context.header('vary', 'Cookie')
    try { await operatorAuth(context.env).requireEditorOwner(context.req.raw) } catch { return context.json({error:'owner required'},403) }
    const bindings = context.env as Bindings & { EDITOR_MANAGEMENT_ORIGIN?: string; EDITOR_INSTALLATION_ID?: string }
    if (!bindings.EDITOR_MANAGEMENT_ORIGIN || !bindings.EDITOR_INSTALLATION_ID) return context.json({error:'editor not configured'},503)
    return context.json({config:{enabled:true,managementOrigin:bindings.EDITOR_MANAGEMENT_ORIGIN,installationId:bindings.EDITOR_INSTALLATION_ID},expiresAt:Date.now()+30000})
  })
  app.get('/api/public/feed'`);
writeFileSync(join(seed,'src/editor-shell.tsx'),`import { useState } from 'react';
import { OwnerEditor, useEditorLeafReady } from './editor/react';
import { configLoader, installCompiledLiveEdits, setLiveEditsReady } from './editor';
import compiled from './editor/visual-edits.json';
if(typeof document!=='undefined'){setLiveEditsReady(false);installCompiledLiveEdits(compiled);}
const load=(signal:AbortSignal)=>configLoader('/api/editor/config',window.location.origin)(signal);
export function EditorShell(){const [error,setError]=useState(false);return <><OwnerEditor authorized={true} load={load} onError={setErrorState}/>{error&&<p role="alert">The editor is unavailable. Reload after checking your owner session.</p>}</>;function setErrorState(){setError(true);}}
export function useLeaf(){useEditorLeafReady(typeof location==='undefined'?'ssr':location.pathname);}
`);
// Stable callback: do not reset authorization on unrelated React renders.
change('src/editor-shell.tsx',"import { useState }", "import { useState, useCallback }");
change('src/editor-shell.tsx',"const [error,setError]=useState(false);return", "const [error,setError]=useState(false);const setErrorState=useCallback(()=>setError(true),[]);return");
change('src/editor-shell.tsx',";function setErrorState(){setError(true);}", ";");
change('src/routes/app.tsx',"import { requireOperator, loadBusinessBrand }", "import { EditorShell } from '../editor-shell'\nimport { requireOperator, loadBusinessBrand }");
change('src/core/app/loaders.ts', '  return session', `  const editorBindings = requestBindings() as ReturnType<typeof requestBindings> & { EDITOR_MANAGEMENT_ORIGIN?: string; EDITOR_INSTALLATION_ID?: string }
  return {...session,editorEnabled:Boolean(editorBindings.EDITOR_MANAGEMENT_ORIGIN && editorBindings.EDITOR_INSTALLATION_ID)}`);
change('src/routes/app.tsx','  const business = Route.useLoaderData()', '  const business = Route.useLoaderData()\n  const { editorEnabled } = Route.useRouteContext()');
// This consumer's compiled edits address the first native main child. Keep
// that leaf before the Business workspace without dropping either surface.
change('src/routes/app.tsx','    <Outlet />','');
change('src/routes/app.tsx','  return <>','  return <>\n    {editorEnabled && <EditorShell />}<Outlet />');
// The sign-in page is operator-auth's server-rendered page, outside the route tree and the editor.
for(const file of ['app.index.tsx','records.tsx','reference.tsx']) {
 const path=join(seed,'src/routes',file);let text=readFileSync(path,'utf8');text="import { useLeaf } from '../editor-shell'\n"+text;text=text.replace(/(function [A-Z][A-Za-z]+\(\) \{)/,'$1\n  useLeaf()');writeFileSync(path,text);
}
change('src/routes/__root.tsx', "import type { ReactNode }", "import { useLeaf } from '../editor-shell'\nimport type { ReactNode }");
change('src/routes/__root.tsx', 'function NotFound() {', 'function NotFound() {\n  useLeaf()');
change('src/router.tsx',"import { routeTree }", "import { setLiveEditsReady } from './editor'\nimport { routeTree }");
change('src/router.tsx','return createRouter({ routeTree, scrollRestoration: true })',`const router = createRouter({ routeTree, scrollRestoration: true })
  router.subscribe('onBeforeNavigate',()=>{if(typeof document!=='undefined')setLiveEditsReady(false)})
  return router`);
writeFileSync(join(output,'.gitignore'),'node_modules\ndefault-seed/dist/\ndefault-seed/.wrangler/\ndefault-seed/.dev.vars\n');
writeFileSync(join(output,'SOURCE.json'),JSON.stringify({baseRevision:revision,kind:'fresh default-seed editor consumer',nativeDispatcher:'foundation/runtime/dispatch.ts',nativeOwner:'operatorAuth.requireEditorOwner'},null,2));
execFileSync('git',['init'],{cwd:output});execFileSync('git',['add','.'],{cwd:output});execFileSync('git',['-c','user.name=Local test consumer','-c','user.email=consumer@example.test','commit','-m','Adopt optional editor in fresh native default-seed consumer'],{cwd:output});
console.log(JSON.stringify({output,baseRevision:revision,consumerRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:output,encoding:'utf8'}).trim()}));
