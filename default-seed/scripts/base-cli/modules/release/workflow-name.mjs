// Read literal top-level YAML names without resolving aliases/tags. Unsupported
// syntax remains selectable by its committed filename, never by an approximation.
function folded(lines) {
  // More-indented folded paragraphs have distinct YAML rules. Refuse them
  // rather than risk selecting a gate by a name it does not actually have.
  if (lines.some(line => /^\s/.test(line))) return undefined;
  return lines.map((line, index) => {
    const next = lines[index + 1];
    const separator = line && next ? ' '
      : line && next === '' && lines.slice(index + 1).some(Boolean) ? '' : '\n';
    return line + separator;
  }).join('');
}

export function workflowName(bytes) {
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const names = lines.flatMap((line, index) => /^(?:name|'name'|"name"):\s*(.*)$/.exec(line)?.slice(1).map(value => ({ value, index })) ?? []);
  if (names.length !== 1) return undefined;
  const { value, index } = names[0];
  const block = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line);
  }
  if (/^[|>][+-]?(?:\s+#.*)?\s*$/.test(value)) {
    const indent = /^ */.exec(block.find(line => line.trim()) ?? '')[0].length;
    const content = block.map(line => line.trim() ? line.slice(indent) : '');
    if (!content.some(Boolean)) return undefined;
    const raw = value[0] === '>' ? folded(content) : content.join('\n') + '\n';
    if (raw === undefined) return undefined;
    if (value[1] === '+') return raw;
    return raw.replace(/\n+$/, value[1] === '-' ? '' : '\n');
  }
  if (value.startsWith('"')) {
    const match = /^"(?:[^"\\]|\\.)*"(?=\s*(?:#|$))/.exec(value);
    try { return match ? JSON.parse(match[0]) : undefined; } catch { return undefined; }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
    return match?.[1].replace(/''/g, "'");
  }
  const plain = [value, ...block.filter(line => !/^\s*#/.test(line))]
    .map(line => line.replace(/\s+#.*$/, '').trim());
  while (plain.length && !plain.at(-1)) plain.pop();
  if (plain.some(line => /^[!&*[{#|>@`%]/.test(line) || /:\s/.test(line))) return undefined;
  return folded(plain)?.replace(/\n+$/, '') || undefined;
}
