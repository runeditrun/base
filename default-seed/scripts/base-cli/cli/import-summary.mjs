// Only declared safe replacement values and aggregate counts reach the terminal.
export function importSummary(details = {}) {
 const { input, tables, target = 'local', objects, captureLog, nextCommand = 'rer setup' } = details;
 if (typeof input !== 'string' || !Array.isArray(tables)) return undefined;
 const rows = tables.reduce((sum, table) => sum + (Number.isSafeInteger(table?.count) ? table.count : 0), 0);
 return [
  `Restored ${target === 'local' ? 'the local copy' : 'the hosted install'} from ${input}: ${count(tables.length, 'table')}, ${count(rows, 'row')}${Number.isSafeInteger(objects) ? `, ${count(objects, 'file')}` : ''}.`,
  importSafetySummary(details),
  captureLog && `Full output: ${captureLog}`,
  `Next: ${nextCommand}${target === 'local' ? ', then rer dev to open the restored app' : ''}.`,
 ].filter(Boolean).join('\n');
}
const count = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;

export function importSafetySummary({safetyChanges}={}) {
 if(!safetyChanges?.length)return undefined;
 return safetyChanges.map(({table,column,value,rows})=>
  `${rows.toLocaleString('en-US')} ${table} imported with ${column}=${JSON.stringify(value)}`
 ).join('\n');
}
