import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A disposable optional editor consumer, using the same Hono/auth integration
// as modules/editor/tests/create-consumer.mjs and the real config grant handler.
// Canonical default/foundation products acquire no editor endpoint.
export async function adoptEditor(root, kind) {
  const destination = join(root, 'src/modules/editor/server');
  await mkdir(destination, { recursive: true });
  await cp(resolve('modules/editor/server/config-response.mjs'), join(destination, 'config-response.mjs'));
  await writeFile(join(destination, 'config-response.d.mts'), `export function createEditorConfigHandler(options: {
    requireOwner(request: Request): Promise<unknown>;
    readConfig(): Promise<unknown>;
  }): (request: Request) => Promise<Response | null>;
`);
  const file = join(root, kind === 'default-seed' ? 'src/core/app/hono.ts' : 'src/server.ts');
  let source = await readFile(file, 'utf8');
  const anchor = kind === 'default-seed' ? "  app.get('/api/public/feed'" : "api.get('/health'";
  assert.ok(source.includes(anchor));
  source = `import { createEditorConfigHandler } from '${kind === 'default-seed' ? '../../' : './'}modules/editor/server/config-response.mjs'\n` + source;
  if (kind === 'default-seed') source = source.replace('import { sessionForRequest }', 'import { sessionForRequest, operatorAuth }');
  else {
    // The Lobby already uses operatorAuth. Give this optional consumer its
    // own binding so adopting it cannot duplicate the template's import.
    source = source.replace('import { authResponse,', 'import { authResponse, operatorAuth as editorOperatorAuth,');
    source = source.replace('new Hono()', 'new Hono<{ Bindings: Bindings }>()');
  }
  source = source.replace(anchor, `  ${kind === 'default-seed' ? 'app' : 'api'}.get('/api/editor/config', async context => {
    const handle = createEditorConfigHandler({
      requireOwner: request => ${kind === 'default-seed' ? 'operatorAuth(context.env)' : 'editorOperatorAuth(runtimeBindings(context.env))'}.requireEditorOwner(request),
      readConfig: async () => ({enabled:true,managementOrigin:'https://management.example.test',installationId:'dependency-consumer'}),
    })
    return (await handle(context.req.raw))!
  })
${anchor}`);
  await writeFile(file, source);
}

export async function editorGrant(page, origin, expected) {
  const response = await page.goto(origin + '/api/editor/config');
  assert.equal(response.status(), expected);
  assert.match(response.headers()['cache-control'], /no-store/);
  const body = await response.json();
  if (expected === 200) assert.equal(body.config.enabled, true);
  else assert.equal(body.error, 'owner_required');
}
