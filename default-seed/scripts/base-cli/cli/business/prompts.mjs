import { createInterface } from 'node:readline/promises';

// Consent can never be inferred from a flag, a prior pairing, or a default.
export async function consent(question) {
 if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(`${question} Run connect in a terminal to answer yes.\n`);
  return false;
 }
 const terminal = createInterface({ input: process.stdin, output: process.stdout });
 try { return (await terminal.question(`${question} [yes/no] `)).trim().toLowerCase() === 'yes'; }
 finally { terminal.close(); }
}

export async function questionCli(available) {
 const choices = [...Object.keys(available), 'none'];
 if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Business questions CLI: none. Run connect in a terminal to choose Claude or Codex.\n');
  return 'none';
 }
 const terminal = createInterface({ input: process.stdin, output: process.stdout });
 try {
  const value = (await terminal.question(`Questions CLI [${choices.join('/')}] (none): `)).trim().toLowerCase() || 'none';
  if (!choices.includes(value)) throw Error('Choose an available questions CLI: Claude, Codex or none. Reconnect to try again.');
  return value;
 } finally { terminal.close(); }
}
