// Prints the registry's latest @runeditrun/rer version on one line. The update
// notice runs this as a child process so that it can kill it at its time budget.
import { packageMetadata } from './registry.mjs';

const latest = (await packageMetadata())['dist-tags']?.latest;
if (typeof latest === 'string') process.stdout.write(latest + '\n');
