import { isAbsolute, relative, sep } from 'node:path';

// How a failed install step names itself, in a terminal and in --json: the
// step, its command, exit code, the last lines it printed and its full log.
export const STEP_OUTPUT_LINES = 20;

// A path inside the checkout is shown from the checkout root: an absolute
// prefix can be masked when the shell's PWD is credential-classified.
export function checkoutPath(root, path) {
 if (!root || !path || !isAbsolute(path)) return path;
 const inside = relative(root, path);
 return inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside) ? inside : path;
}

export function stepDiagnostic({ name, command, exitCode, signal, output, log }) {
 const lines = (Array.isArray(output) ? output : String(output ?? '').split('\n')).map(String);
 while (lines.length && !lines.at(-1).trim()) lines.pop();
 return { name: String(name ?? 'Installing'), command: command ?? null, exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: signal ?? null, output: lines.slice(-STEP_OUTPUT_LINES), log: log ?? null };
}

export function stepFailureText(step) {
 return [
  `Install step failed: ${step.name}`,
  `Command: ${step.command ?? '(none: the step failed inside rer)'}`,
  `Exit code: ${step.exitCode ?? 'none'}${step.signal ? ` (signal ${step.signal})` : ''}`,
  `Last ${STEP_OUTPUT_LINES} lines of output:`,
  ...(step.output.length ? step.output : ['(no output)']),
  `Full log: ${step.log ?? '(none)'}`,
 ].join('\n');
}
