import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shared } from './shared.mjs';

export async function demoBundle(project, operation, declaration, output) {
  const { root } = project;
  const { withoutLocalVariables } = await shared('local/build.mjs');
  const { buildEnvironment } = await shared('local/environment.mjs');
  const seed = await readFile(join(root, 'seed.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const declared = Array.isArray(seed.env) ? seed.env.map(item => item.name) : Object.keys(seed.env ?? {});
  await withoutLocalVariables(root, async () => {
    const builder = fileURLToPath(new URL('../modules/demo-host/build.mjs', import.meta.url));
    const child = spawn(process.execPath, [builder, root, output, JSON.stringify(declaration)], {
      cwd: root, stdio: 'inherit', env: buildEnvironment([...declared, ...(declaration.secrets ?? []).flatMap(item => [item.binding, item.environment])]),
    });
    const abort = () => child.kill('SIGTERM');
    process.once('SIGTERM', abort); process.once('SIGINT', abort);
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Demo build failed'))); }); }
    finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  }, { nested: operation.token, settings: [...(project.adapter?.settings ?? []), ...(project.privateInputs ?? [])] });
}
