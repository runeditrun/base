import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Add demo-only preparation to an ordinary workerd image build folder. */
export async function prepareDemoImage(image) {
 const manifest = JSON.parse(await readFile(join(image, 'app/container.json'), 'utf8'));
 if (manifest.engine !== 'workerd') throw new Error('demo-template-requires-workerd');
 const path = join(image, 'Dockerfile'), dockerfile = await readFile(path, 'utf8');
 const entrypoint = 'ENTRYPOINT ["sh", "/runtime/modules/container/entrypoint.sh"]';
 if (!dockerfile.endsWith(entrypoint + '\n')) throw new Error('demo-image-entrypoint-changed');
 const runtime = join(image, 'runtime/modules/demo-host');
 await mkdir(runtime, { recursive: true });
 for (const file of ['prepare.mjs', 'template.mjs', 'entrypoint.sh']) await cp(new URL(file, import.meta.url), join(runtime, file));
 await writeFile(path, dockerfile.slice(0, -entrypoint.length - 1)
  + 'RUN --network=none node /runtime/modules/demo-host/prepare.mjs\n'
  + 'ENTRYPOINT ["sh", "/runtime/modules/demo-host/entrypoint.sh"]\n');
 return { output: image };
}
