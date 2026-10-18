// Read a top-level literal YAML name without executing expressions or resolving
// aliases/tags. Unsupported names remain selectable by their committed filename.
export function workflowName(bytes) {
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const names = lines.flatMap((line, index) => /^(?:name|'name'|"name"):\s*(.*)$/.exec(line)?.slice(1).map(value => ({ value, index })) ?? []);
  if (names.length !== 1) return undefined;
  const { value, index } = names[0];
  if (/^[|>][+-]?(?:\s+#.*)?\s*$/.test(value)) {
    const block = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      block.push(line);
    }
    while (block.length && !block.at(-1).trim()) block.pop();
    const indent = Math.min(...block.filter(line => line.trim()).map(line => /^ */.exec(line)[0].length));
    const content = block.map(line => line.slice(indent));
    let name = content.join('\n');
    if (value[0] === '>') name = name.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    return name + (value[1] === '-' ? '' : '\n');
  }
  if (value.startsWith('"')) {
    const match = /^"(?:[^"\\]|\\.)*"(?=\s*(?:#|$))/.exec(value);
    try { return match ? JSON.parse(match[0]) : undefined; } catch { return undefined; }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
    return match?.[1].replace(/''/g, "'");
  }
  const name = value.replace(/\s+#.*$/, '').trim();
  return name && !/^[!&*[{#|>@`%]/.test(name) && !/:\s/.test(name) ? name : undefined;
}
