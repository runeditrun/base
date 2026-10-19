// Only declared safe replacement values and aggregate counts reach the terminal.
export function importSafetySummary({safetyChanges}={}) {
 if(!safetyChanges?.length)return undefined;
 return safetyChanges.map(({table,column,value,rows})=>
  `${rows.toLocaleString('en-US')} ${table} imported with ${column}=${JSON.stringify(value)}`
 ).join('\n');
}
