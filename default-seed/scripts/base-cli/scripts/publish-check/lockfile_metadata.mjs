// Return only scalar value locations in dependency package contact metadata.
// Use the maintained YAML parser; no package installation or lockfile execution.
import { readFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument, visit } from '../../edition-authoring/vendor/yaml/index.mjs';

const personFields = new Set(['name', 'email', 'url']);
const single = new Set(['author', 'maintainer']);
const multiple = new Set(['maintainers', 'contributors']);
const packageName = /^(?:@[^\s/@]+\/)?[^\s/@]+$/;
const selector = /^(?:@[^\s/@]+\/)?[^\s/@]+@[^\s]+$/;
const pnpmSelector = /^(?:\/?(?:@[^\s/@]+\/)?[^\s/@]+)(?:@|\/)[^\s]+$/;
const key = node => isScalar(node) && typeof node.value === 'string' ? node.value : null;
const field = (node, name) => isMap(node) ? node.items.find(pair => key(pair.key) === name)?.value : undefined;
const string = node => isScalar(node) && typeof node.value === 'string';

function metadata(node, spans) {
  if (!isMap(node)) return;
  const scalar = value => { if (string(value)) spans.push(value.range.slice(0, 2)); };
  const person = value => {
    if (string(value)) scalar(value);
    else if (isMap(value) && value.items.every(pair => personFields.has(key(pair.key)) && string(pair.value))) {
      for (const pair of value.items) scalar(pair.value);
    }
  };
  for (const pair of node.items) {
    const name = key(pair.key), value = pair.value;
    if (single.has(name)) person(value);
    else if (multiple.has(name) && isSeq(value)) for (const entry of value.items) person(entry);
    // npm's deprecation advisory is registry-supplied package metadata too.
    else if (name === 'email' || name === 'deprecated') scalar(value);
  }
}

function structured(text, filename) {
  if (filename === 'package-lock.json') JSON.parse(text);
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length || !isMap(document.contents)) return [];
  let ambiguous = false;
  visit(document, { Node(_, node) { if (node.tag || node.anchor || node.constructor.name === 'Alias') ambiguous = true; } });
  if (ambiguous) return [];
  const root = document.contents, spans = [];
  if (filename === 'pnpm-lock.yaml') {
    if (!/^(?:[1-9]\d*)(?:\.\d+)?$/.test(String(field(root, 'lockfileVersion')?.value ?? ''))) return [];
    const packages = field(root, 'packages');
    if (isMap(packages)) for (const pair of packages.items) {
      if (pnpmSelector.test(key(pair.key) ?? '')) metadata(pair.value, spans);
    }
  } else if (filename === 'package-lock.json') {
    const version = field(root, 'lockfileVersion')?.value;
    if (![1, 2, 3].includes(version)) return [];
    const packages = field(root, 'packages');
    if (version >= 2 && isMap(packages)) for (const pair of packages.items) {
      // The empty key is the repository's own package, never a dependency.
      if (/(?:^|\/)node_modules\/(?:@[^/\s]+\/)?[^/\s]+$/.test(key(pair.key) ?? '') &&
          string(field(pair.value, 'version'))) metadata(pair.value, spans);
    }
    const dependencies = node => {
      if (!isMap(node)) return;
      for (const pair of node.items) if (packageName.test(key(pair.key) ?? '') && isMap(pair.value)) {
        if (string(field(pair.value, 'version'))) metadata(pair.value, spans);
        dependencies(field(pair.value, 'dependencies'));
      }
    };
    if (version <= 2) dependencies(field(root, 'dependencies'));
  } else {
    if (!isMap(field(root, '__metadata')) || !field(field(root, '__metadata'), 'version')) return [];
    for (const pair of root.items) {
      if ((key(pair.key) ?? '').split(/,\s*/).every(name => selector.test(name))) metadata(pair.value, spans);
    }
  }
  return spans;
}

function classic(text) {
  // Yarn v1 is not YAML: scalar members omit the colon and selectors can be
  // grouped. Parse its indentation and JSON-quoted strings before classifying.
  if (!/^# yarn lockfile v1\r?$/m.test(text)) return [];
  const spans = [], stack = [], records = [], selectors = new Set();
  let offset = 0, current = null;
  for (const line of text.split(/(?<=\n)/)) {
    const raw = line.replace(/\r?\n$/, '');
    const start = offset;
    offset += line.length;
    if (/^\s*(?:#.*)?$/.test(raw)) continue;
    if (!raw.startsWith(' ')) {
      const header = raw.match(/^((?:"(?:[^"\\]|\\.)*"|[^\s",]+)(?:,\s*(?:"(?:[^"\\]|\\.)*"|[^\s",]+))*):$/);
      if (!header) return [];
      const names = header[1].match(/"(?:[^"\\]|\\.)*"|[^\s,]+/g).map(value => value.startsWith('"') ? JSON.parse(value) : value);
      if (!names.every(name => selector.test(name) && !selectors.has(name))) return [];
      for (const name of names) selectors.add(name);
      current = { items: [], keys: new Set() };
      records.push(current);
      stack.splice(0, stack.length, { indent: 0, node: current });
      continue;
    }
    if (!current) return [];
    const member = raw.match(/^( +)("(?:[^"\\]|\\.)*"|[A-Za-z][A-Za-z0-9_-]*)(?::|[ \t]+((?:"(?:[^"\\]|\\.)*"|[^\s"#]+)))([ \t]*(?:#.*)?)$/);
    if (!member) return [];
    const indent = member[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    if (!parent || indent !== parent.indent + 2) return [];
    const name = member[2].startsWith('"') ? JSON.parse(member[2]) : member[2];
    if (parent.node.keys.has(name)) return [];
    parent.node.keys.add(name);
    let value;
    if (member[3] === undefined) {
      value = { items: [], keys: new Set() };
      stack.push({ indent, node: value });
    } else {
      const at = start + member[1].length + member[2].length + raw.slice(member[1].length + member[2].length).search(/\S/);
      const decoded = member[3].startsWith('"') ? JSON.parse(member[3]) : member[3];
      value = { value: decoded, range: [at, at + member[3].length] };
    }
    parent.node.items.push({ name, value });
  }
  // Only direct package metadata and documented person members qualify.
  const person = value => {
    if (typeof value.value === 'string') spans.push(value.range);
    else if (value.items.every(pair => personFields.has(pair.name) && typeof pair.value.value === 'string')) {
      for (const pair of value.items) spans.push(pair.value.range);
    }
  };
  for (const record of records) {
    for (const pair of record.items) {
      if (single.has(pair.name)) person(pair.value);
      else if (['email', 'deprecated'].includes(pair.name) && typeof pair.value.value === 'string') spans.push(pair.value.range);
    }
  }
  return spans;
}

try {
  const text = readFileSync(0, 'utf8');
  const filename = process.argv[2];
  const spans = filename === 'yarn.lock' && /^# yarn lockfile v1\r?$/m.test(text) ? classic(text) : structured(text, filename);
  process.stdout.write(JSON.stringify(spans.map(([a, b]) => [Buffer.byteLength(text.slice(0, a)), Buffer.byteLength(text.slice(0, b))])));
} catch {
  // Malformed/unsupported input grants no metadata exception.
  process.stdout.write('[]');
}
