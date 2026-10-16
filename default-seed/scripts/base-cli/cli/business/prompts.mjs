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
