import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shared } from './shared.mjs';

// The build runs as a captured command: its output, including the reason it
// failed, reaches the terminal and the capture log, and a failure says so.
export async function demoBundle(project, operation, declaration, output, store, label, signal) {
  const { root } = project;
  const { withoutLocalVariables } = await shared('local/build.mjs');
  const { buildEnvironment } = await shared('local/environment.mjs');
  const seed = await readFile(join(root, 'seed.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const declared = Array.isArray(seed.env) ? seed.env.map(item => item.name) : Object.keys(seed.env ?? {});
  await withoutLocalVariables(root, async () => {
    const builder = fileURLToPath(new URL('../modules/demo-host/build.mjs', import.meta.url));
    await store.run(label, process.execPath, [builder, root, output, JSON.stringify(declaration)], {
      cwd: root, signal, phase: 'build', env: buildEnvironment([...declared, ...(declaration.generatedSecrets ?? []).map(item => item.name), ...(declaration.secrets ?? []).flatMap(item => [item.binding, item.environment])]),
    });
  }, { nested: operation.token, settings: [...(project.adapter?.settings ?? []), ...(project.privateInputs ?? [])] });
}
