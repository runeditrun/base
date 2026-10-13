import { symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = fileURLToPath(new URL('../../', import.meta.url));

// Preserve the workspace layout used by pnpm's executable shims as well as
// its package symlinks. The disposable seed runs the real installed packages.
export async function useWorkspaceDependencies(root) {
  await symlink(join(base, 'node_modules'), join(dirname(root), 'node_modules'), 'dir');
  await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
}
