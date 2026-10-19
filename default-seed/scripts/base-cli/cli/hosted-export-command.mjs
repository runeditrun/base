import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, win32 } from 'node:path';
import { constants } from 'node:os';
import { contained } from './project.mjs';
import { locateExport } from './archive-path.mjs';
import { RerError, refuse, lifecycleError } from './errors.mjs';
import { shared } from './shared.mjs';

// A checkout executable, or a bare interpreter followed immediately by its
// checkout script. Interpreter switches and shell command strings are not hooks.
export async function hostedExportCommand(root, argv) {
 const message = 'portability.hostedExport must be an argv array naming a relative regular checkout script, without absolute paths, traversal or symlinks.';
 if (!Array.isArray(argv) || !argv.length || ![...argv].every(arg => typeof arg === 'string' && arg.trim() && !arg.includes('\0'))) throw refuse(message);
 const [program, ...args] = argv;
 if (isAbsolute(program) || win32.isAbsolute(program) || !/^[\w.+/-]+$/.test(program)) throw refuse(message);
 const direct = program.includes('/'), script = direct ? program : args[0];
 if (typeof script !== 'string' || script.startsWith('-') || win32.isAbsolute(script)) throw refuse(message);
 let path;
 try { path = await contained(root, script); if (!(await lstat(path)).isFile()) throw Error(); }
 catch { throw refuse(message); }
 return direct ? [path, ...args] : [program, ...args];
}

export async function runHostedExport(project, options, store, signal) {
 const [program, ...args] = await hostedExportCommand(project.root, project.adapter.portability.hostedExport);
 const file = options.output ?? `exports/hosted-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
 const located = await locateExport(project.root, file);
 await located.unserved();
 // The hook owns the archive format: its output may be a file or a directory.
 const output = isAbsolute(file) ? located.path : relative(project.root, located.path);
 const details = { hostedExport: true, target: 'remote', output, ...(options.origin ? { origin: new URL(options.origin).origin } : {}) };
 const argv = [...args, '--remote', '--environment', 'production', '--out', output, ...(details.origin ? ['--origin', details.origin] : [])];
 try {
  // Like deploy hooks, the seed's own code receives the caller environment.
  // No settings, credentials or hosted data are read by this dispatcher.
  await store.run('Exporting hosted installation data', program, argv, { cwd: project.root, signal, env: { ...process.env } });
 } catch (error) {
  const { isBusyFailure } = await shared('failures.mjs');
  if (isBusyFailure(error)) throw error;
  const diagnostic = await lifecycleError(error, store);
  const code = error.signal ? 128 + (constants.signals[error.signal] ?? 0) : Number.isInteger(error.childExitCode) && error.childExitCode > 0 ? error.childExitCode : 1;
  throw new RerError('hosted_export_failed', diagnostic.message, code, { childExitCode: error.childExitCode, signal: error.signal, exportDetails: details });
 }
 const status = await lstat(located.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
 if (!status || !status.isFile() && !status.isDirectory()) throw new RerError('hosted_export_missing_output', `The hosted export command exited 0 but did not leave a regular file or directory at ${output}.`, 1, { childExitCode: 0, exportDetails: details });
 return { ...details, childExitCode: 0 };
}
