import { isAbsolute } from 'node:path';
import { constants } from 'node:os';
import { inspectRequiredLoops } from '../operations/project-operations.mjs';
import { contained } from './project.mjs';
import { missing, refuse, RerError, lifecycleError } from './errors.mjs';
import { shared } from './shared.mjs';

export async function executeDeclared(project, options, store, signal) {
 if (project.descriptor.version !== 2) throw refuse('Execution requires explicit OPERATIONS v2 argv; version 1 remains inspection-only.');
 const command = project.descriptor.commands[options.verb];
 if (!command) throw refuse('No command declared for this verb. Add a real OPERATIONS v2 argv or use the project commands.');
 for (const input of command.inputs) await contained(project.root, input);
 const absent = project.descriptor.requiredEnvironment.filter(name => typeof process.env[name] !== 'string' || !process.env[name].trim());
 const loops = inspectRequiredLoops(project.descriptor, process.env);
 if (absent.length || loops.some(loop => !['ready', 'optional-disabled'].includes(loop.status))) throw missing(`Required declared inputs or loops are missing. See ${project.descriptor.documentation?.document ?? 'the project operating documentation'}.`);
 const [program, ...argv] = command.argv;
 if (!isAbsolute(program) && (program.includes('/') || program.includes('\\'))) await contained(project.root, program);
 try {
  await store.run('Running declared project command', program, [...argv, ...options.forwarded], { cwd: project.root, signal });
  return { childExitCode: 0, signal: null };
 } catch (error) {
  const { isBusyFailure } = await shared('failures.mjs');
  if (isBusyFailure(error)) throw error;
  const diagnostic = await lifecycleError(error, store);
  const code = error.signal ? 128 + (constants.signals[error.signal] ?? 0) : Number.isInteger(error.childExitCode) && error.childExitCode >= 0 ? error.childExitCode : 3;
  throw new RerError('child_failed', diagnostic.message, code, { childExitCode: error.childExitCode, signal: error.signal });
 }
}
