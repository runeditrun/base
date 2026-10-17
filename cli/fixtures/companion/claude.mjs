#!/usr/bin/env node
// A stand-in for `claude -p ... --output-format stream-json` that opens a
// session and then keeps working until it is stopped.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

appendFileSync(join(process.env.HOME, 'spawns'), `${process.pid}\n`);
writeFileSync(join(process.env.HOME, 'claude-argv.json'), JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }) + '\n');
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
