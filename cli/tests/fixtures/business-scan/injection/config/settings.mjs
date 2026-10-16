// Executable configuration is never evaluated by discovery.
import { writeFileSync } from 'node:fs';
writeFileSync('command-canary', 'synthetic');
