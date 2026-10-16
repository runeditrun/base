// Source support is deliberately limited to literal provider imports and calls
// through those imports. Nothing is imported, instantiated or executed.
export function pulumiNames(pathname, source, add) {
 const aliases = new Map(), executable = maskStrings(source), maskedLines = executable.split(/\r?\n/), lines = source.split(/\r?\n/);
 const register = (alias, provider) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || !/^[a-z][a-z0-9_-]*$/.test(provider)) return;
  if (provider === 'pulumi') return;
  aliases.set(alias, provider); add('iac-provider', provider);
 };
 if (/\.[cm]?[jt]sx?$/i.test(pathname)) {
  for (let index = 0; index < lines.length; index++) {
   const line = lines[index]; if (!/^\s*(?:import|const|let|var)\b/.test(maskedLines[index])) continue;
   const imported = /^\s*import\s+(?:\*\s+as\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+from\s+(["'])@pulumi\/([a-z][a-z0-9_-]*)\2(?=\s*(?:;|$))/.exec(line);
   if (imported) register(imported[1], imported[3]);
   const required = /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(\s*(["'])@pulumi\/([a-z][a-z0-9_-]*)\2\s*\)(?=\s*(?:;|$))/.exec(line);
   if (required) register(required[1], required[3]);
  }
 } else if (/\.py$/i.test(pathname)) {
  for (let index = 0; index < lines.length; index++) {
   const line = lines[index]; if (!/^\s*(?:import|from)\b/.test(maskedLines[index])) continue;
   const imported = /^\s*import\s+pulumi_([a-z][a-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(line);
   if (imported) register(imported[2] ?? `pulumi_${imported[1]}`, imported[1]);
   const from = /^\s*from\s+pulumi_([a-z][a-z0-9_]*)\s+import\s+([a-z][a-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(line);
   if (from) register(from[3] ?? from[2], from[1]);
  }
 } else if (/\.go$/i.test(pathname)) {
  let imports = false;
  for (const line of source.split(/\r?\n/)) {
   if (/^\s*import\s*\(\s*$/.test(line)) { imports = true; continue; }
   if (/^\s*\)\s*$/.test(line)) imports = false;
   const imported = new RegExp(`^\\s*${imports ? '' : 'import\\s+'}(?:([A-Za-z_][A-Za-z0-9_]*)\\s+)?"github\\.com/pulumi/pulumi-([a-z][a-z0-9_-]*)/sdk/(?:v[0-9]+/)?go/([A-Za-z0-9_/]+)"\\s*$`).exec(line);
   if (imported) register(imported[1] ?? imported[3].split('/').at(-1), imported[2]);
  }
 }
 // Mask all strings and heredocs before looking for constructor expressions.
 // Otherwise a code example embedded in a description could become live use.
 for (const match of executable.matchAll(/\b(?:new\s+)?([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\(/g)) {
  if (!aliases.has(match[1])) continue;
  const type = match[2].slice(1).split('.').at(-1);
  if (/^[A-Z]/.test(type) && type !== 'Provider') add('iac-resource', `${match[1]}${match[2]}`);
 }
 if (/\.cs$/i.test(pathname)) {
  for (const match of executable.matchAll(/\bnew\s+(Pulumi\.([A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*)+)\s*\(/g)) {
   add('iac-provider', match[2]); if (!match[1].endsWith('.Provider')) add('iac-resource', match[1]);
  }
 }
}

export function maskStrings(source) {
 let result = '', quote = '', triple = false;
 for (let i = 0; i < source.length; i++) {
  const char = source[i];
  if (quote) {
   result += char === '\n' ? '\n' : ' ';
   if (char === '\\' && quote !== '`') { const next = source[++i]; result += next === '\n' ? '\n' : ' '; }
   else if (triple && source.slice(i, i + 3) === quote.repeat(3)) { result += '  '; i += 2; quote = ''; triple = false; }
   else if (!triple && char === quote) quote = '';
  } else if (['"', "'", '`'].includes(char)) {
   quote = char; result += ' ';
   if (source.slice(i, i + 3) === char.repeat(3)) { triple = true; result += '  '; i += 2; }
  } else result += char;
 }
 return result;
}
