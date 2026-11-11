// A declared SQLite expression (or `after` statement) is one expression: a `;` outside quotes and comments would
// start a second statement inside the INSERT … SELECT the later clauses build around it.
export const maxExpressionLength = 2000;

export function topLevelSemicolon(sql) {
 const closing = { "'": "'", '"': '"', '`': '`', '[': ']' };
 for (let i = 0; i < sql.length; i++) {
  const char = sql[i];
  if (closing[char]) {
   const end = closing[char];
   // A doubled quote inside a quoted string is a literal quote; brackets have no escape.
   for (i++; i < sql.length; i++) {
    if (sql[i] !== end) continue;
    if (end !== ']' && sql[i + 1] === end) i++;
    else break;
   }
  } else if (char === '-' && sql[i + 1] === '-') {
   while (i < sql.length && sql[i] !== '\n') i++;
  } else if (char === '/' && sql[i + 1] === '*') {
   const end = sql.indexOf('*/', i + 2);
   if (end < 0) return false;
   i = end + 1;
  } else if (char === ';') return true;
 }
 return false;
}

// undefined when valid, else what is wrong.
export function expressionProblem(sql) {
 if (typeof sql !== 'string' || !sql.trim()) return 'must be one SQLite expression in a string';
 if (sql.length > maxExpressionLength) return `is ${sql.length} characters; keep it to ${maxExpressionLength} or fewer`;
 if (topLevelSemicolon(sql)) return "has a ';' outside quotes; write one expression, not several statements";
}
