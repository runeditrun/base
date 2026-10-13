#!/usr/bin/env node
// The installed `rer` command. This file avoids newer syntax so that an old
// Node still reaches the one-line minimum-version message.
import { readFileSync } from 'node:fs';
import { handleBrokenPipes } from './output.mjs';

handleBrokenPipes();

function manifest() {
 // Packed: the package's own package.json. From a Base checkout: the template.
 var packed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
 return packed.name === '@runeditrun/rer' ? packed : JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
}

function below(actual, minimum) {
 var a = actual.split('.').map(Number), m = minimum.split('.').map(Number);
 for (var i = 0; i < 3; i++) { if ((a[i] || 0) !== (m[i] || 0)) return (a[i] || 0) < (m[i] || 0); }
 return false;
}

var minimum = manifest().engines.node.replace(/^>=\s*/, '');
if (process.platform === 'win32') {
 process.stderr.write('rer runs on macOS and Linux. On Windows, install it inside WSL2.\n');
 process.exitCode = 1;
} else if (below(process.versions.node, minimum)) {
 process.stderr.write('rer needs Node ' + minimum + ' or later; this is Node ' + process.versions.node + '. Install a newer Node, then run rer again.\n');
 process.exitCode = 1;
} else {
 import('./main.mjs').then(function (module) { return module.main(process.argv.slice(2)); }).then(function (code) {
  if (code !== undefined) process.exitCode = code;
 });
}
