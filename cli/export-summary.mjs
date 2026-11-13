import { shellQuote } from './node-runtime-cache.mjs';
// The one line a finished export ends with: which copy it exported, the
// archive, its size and what it holds.
export function exportSummary({ target = 'local', origin, output, bytes, tables, captureLog, hostedExport, childExitCode, exitCode = childExitCode } = {}) {
 if (typeof output !== 'string') return undefined;
 const copy = target === 'remote' ? `the hosted install${origin ? ` at ${origin}` : ''}` : 'the local copy';
 if (hostedExport && Number.isInteger(exitCode)) return exitCode === 0 ? `Exported ${copy} to ${output} (exit 0)` : `Export of ${copy} to ${output} failed (exit ${exitCode})`;
 if (!Number.isSafeInteger(bytes) || !Array.isArray(tables)) return undefined;
 const rows = tables.reduce((sum, table) => sum + (Number.isSafeInteger(table?.count) ? table.count : 0), 0);
 const file = /^[A-Za-z0-9_./-]+$/.test(output) ? output : shellQuote(output);
 return [
  `Exported ${copy} to ${output} (${size(bytes)}): ${counted(tables.length, 'table')}, ${counted(rows, 'row')}`,
  captureLog && `Full output: ${captureLog}`,
  `To restore into an empty installation: rer import --input ${file} --yes`,
 ].filter(Boolean).join('\n');
}

const counted = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;

function size(bytes) {
 const units = ['B', 'KB', 'MB', 'GB', 'TB'];
 let value = bytes, unit = 0;
 while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
 return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
