// Preparation failures and legacy dispatcher output use the invocation that
// the person's shell can run. Qualify messages before JSON serialization so
// quoted paths remain valid data.
export function qualifyHints(value, stopHint) {
 if (!stopHint) return value;
 const end = stopHint.indexOf(' dev --stop');
 if (end < 0) return value;
 const invocation = stopHint.slice(0, end);
 // Consume cwd arguments intact, including command-like words in a quoted
 // folder name. One pass never qualifies text inside a target a second time.
 if (typeof value === 'string') return value.replace(
  / --cwd (?:'[^']*'|"(?:\\.|[^"\\])*"|\S+)|(?<![\w/.~-])rer (dev|preview) --stop(?: --cwd (?:'[^']*'|"(?:\\.|[^"\\])*"|\S+))?|(?<![\w/.~-])rer (?=(?:dev|preview|setup|open)\b)/g,
  (command, verb) => command.startsWith(' --cwd ') ? command
   : verb && !command.includes(' --cwd ') ? stopHint.replace(' dev --stop', ` ${verb} --stop`)
   : command.replace(/^rer /, () => invocation + ' '));
 if (Array.isArray(value)) return value.map(item => qualifyHints(item, stopHint));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualifyHints(item, stopHint)]));
 return value;
}
