import { execFile } from 'node:child_process';
export async function git(directory, args, signal) {
  // Never let a caller's current Git worktree/index redirect the new checkout.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  try {
    const result = await new Promise((resolve, reject) => {
      let failure, stdout;
      const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...args], {
        cwd: directory, env, maxBuffer: 1024 * 1024, signal,
      }, (error, output) => { failure = error; stdout = output; });
      // Abort reports an error before process closure. Wait until our child closes
      // before acquisition may remove its working directory.
      child.once('close', () => failure ? reject(failure) : resolve(stdout));
    });
    return result.trim();
  } catch (error) {
    if (signal?.aborted) throw Error('Source acquisition canceled.');
    if (error.code === 'ENOENT') throw Error('Git is required. Install Git and run setup again.');
    // Git/provider errors can contain authentication URLs. Do not echo them.
    throw Error(`Git ${args[0]} failed. Check repository access, the requested ref and existing Git authentication.`);
  }
}
