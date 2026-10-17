// The one line a finished export ends with: which copy it exported, the
// archive, its size and what it holds.
export function exportSummary({ target = 'local', origin, output, bytes, tables } = {}) {
 if (typeof output !== 'string' || !Number.isSafeInteger(bytes) || !Array.isArray(tables)) return undefined;
 const rows = tables.reduce((sum, table) => sum + (Number.isSafeInteger(table?.count) ? table.count : 0), 0);
 const copy = target === 'remote' ? `the hosted install${origin ? ` at ${origin}` : ''}` : 'the local copy';
 return `Exported ${copy} to ${output} (${size(bytes)}): ${counted(tables.length, 'table')}, ${counted(rows, 'row')}`;
}

const counted = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;

function size(bytes) {
 const units = ['B', 'KB', 'MB', 'GB', 'TB'];
 let value = bytes, unit = 0;
 while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
 return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
