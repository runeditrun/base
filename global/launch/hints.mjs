// Preparation failures and legacy dispatcher output use the invocation that
// the person's shell can run. Qualify messages before JSON serialization so
// quoted paths remain valid data.
export function qualifyHints(value, stopHint) {
 if (!stopHint) return value;
 const end = stopHint.indexOf(' dev --stop');
 if (end < 0) return value;
 const invocation = stopHint.slice(0, end);
 if (typeof value === 'string') return value
  .replace(/(?<![\w/.~-])rer (dev|preview) --stop(?: --cwd (?:'[^']*'|"[^"]*"|\S+))?/g,
   (command, verb) => / --cwd /.test(command)
    ? command.replace(/^rer /, () => invocation + ' ')
    : stopHint.replace(' dev --stop', ` ${verb} --stop`))
  .replace(/(?<![\w/.~-])rer (?=(?:dev|preview|setup|open)\b)/g, () => invocation + ' ');
 if (Array.isArray(value)) return value.map(item => qualifyHints(item, stopHint));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualifyHints(item, stopHint)]));
 return value;
}
