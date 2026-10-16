import { scan } from './scan.mjs';

const usage = 'Usage: rer business scan [DIR...] [--json]\nNames-only local discovery; returns rer-business-signals/1 JSON. No network calls.\n';

export async function scanCommand(argv) {
 if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0]) || argv[0] === 'scan' && argv.slice(1).some(arg => ['--help', '-h'].includes(arg))) {
  process.stdout.write(usage); return 0;
 }
 if (argv[0] !== 'scan') { process.stderr.write(usage); return 2; }
 const directories = [];
 let positional = false, json = false;
 for (const arg of argv.slice(1)) {
  if (!positional && arg === '--') { positional = true; continue; }
  if (!positional && arg === '--json' && !json) { json = true; continue; }
  if (!positional && arg.startsWith('-') || !arg.trim()) { process.stderr.write(usage); return 2; }
  directories.push(arg);
 }
 try {
  const result = await scan(directories.length ? directories : [process.cwd()]);
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
 } catch {
  // Node/format errors can contain input paths, keys or source excerpts.
  process.stderr.write('Business scan could not read a local input. No scan document was emitted.\n');
  return 1;
 }
}
