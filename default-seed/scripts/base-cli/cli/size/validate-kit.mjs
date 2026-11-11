// Small pieces shared by the size-check.json validators: a problem list keyed by field path, key and number checks,
// and the {{var}} / {{persona.var}} template scan.
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isInt = (value, low, high = Infinity) => Number.isInteger(value) && value >= low && value <= high;
export const count = number => number.toLocaleString('en-US');
export const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/, slug = /^[a-z0-9][a-z0-9-]{0,63}$/, name = /^[a-z][a-z0-9_]{0,31}$/, variable = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Every problem is { path, message }: the path is the dotted field path the clause id carries.
export function problems() {
 const list = [];
 return { list, add: (path, message) => { list.push({ path: path.join('.'), message }); } };
}

// The value as an object with only the allowed keys; unknown keys are refused by name.
export function keyed(found, value, path, allowed, label = 'it') {
 if (!isObject(value)) { found.add(path, `must be an object; write { ${allowed.slice(0, 3).join(', ')}, … } (allowed keys: ${allowed.join(', ')}).`); return false; }
 for (const key of Object.keys(value)) if (!allowed.includes(key)) found.add([...path, key], `unknown key "${key}"; remove it or correct the spelling (allowed in ${label}: ${allowed.join(', ')}).`);
 return true;
}

export function integer(found, value, path, low, high, fix) {
 if (isInt(value, low, high)) return true;
 found.add(path, `must be a whole number ${high === undefined || high === Infinity ? `of at least ${count(low)}` : `from ${count(low)} to ${count(high)}`}${fix ? `; ${fix}` : ''}.`);
 return false;
}

export function* stringsIn(value) {
 if (typeof value === 'string') yield value;
 else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item);
 else if (isObject(value)) for (const item of Object.values(value)) yield* stringsIn(item);
}

// Each {{…}} in the text as { persona?, variable } or { bad } when it is neither {{var}} nor {{persona.var}}.
export function templateRefs(text) {
 return [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => {
  const parts = match[1].trim().split('.');
  if (parts.length === 1 && variable.test(parts[0])) return { variable: parts[0] };
  if (parts.length === 2 && name.test(parts[0]) && variable.test(parts[1])) return { persona: parts[0], variable: parts[1] };
  return { bad: match[0] };
 });
}

export const pathProblem = path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..');
