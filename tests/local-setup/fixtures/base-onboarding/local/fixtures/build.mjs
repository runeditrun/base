// Test-only historical build entrypoint.
import {withoutLocalVariables} from '../build.mjs';
import {buildEnvironment} from '../environment.mjs';
import {runCommand} from './command.mjs';

// `pnpm build`: the complete build runs without local bindings, including
// preview startup, and prints a plain failure.
export async function runLocalBuild(root, { args = process.argv.slice(2), command = 'pnpm', commandArgs = ['exec', 'vite', 'build'] } = {}) {
  const cancellation = new AbortController()
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
    const error = new Error(`Cancelled by ${signal}.`)
    error.signal = signal
    cancellation.abort(error)
  }]))
  for (const [signal, handler] of handlers) process.on(signal, handler)
  const failed = (message) => { console.error(message); process.exitCode = 1 }
  try {
    await withoutLocalVariables(root, ({ secrets }) => runCommand(command, [...commandArgs, ...args], {
      cwd: root, env: buildEnvironment(), signal: cancellation.signal, secrets,
      write: (text) => process.stdout.write(text),
    }), { report: failed })
  } catch (error) {
    failed(`Build failed: ${error.message}`)
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}
