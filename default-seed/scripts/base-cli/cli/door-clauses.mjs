import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseContract } from '../foundation/runtime/seed-contract.mjs';
import { RerError } from './errors.mjs';

export const clausesHelp = `Usage: rer door clauses (--write | --check) [--cwd DIR]

Synchronize BASE-AGENT-001 through BASE-AGENT-013 in CONTRACT.md.
--write adds or updates Base's requirements, preserving existing status,
evidence and gaps, then runs the seed's contract-docs write and check.
--check is read-only and names missing or stale clauses (exit 1).
Seed-owned clauses and the judged revision stay unchanged. Newly added clauses
start missing. Regenerate the seed's source lock last, before committing.
`;
const fail = message => { throw new RerError('agent_clauses_invalid', message, 1); };
const read = file => readFileSync(file, 'utf8');
const area = '### Agent surface (Base-delivered)';

// Directory records deliver new non-code files on refresh, too. A recorded
// clause copy selects its immutable text; older runtime pins without this file
// can still sync their contract using the CLI's independently delivered source.
function canonical(root) {
 const record = resolve(root, 'base-copies.json');
 if (existsSync(record)) {
  const origin = 'modules/agent-door/CLAUSES.md';
  const candidates = JSON.parse(read(record)).copies?.filter(copy => origin === copy.originPath || origin.startsWith(copy.originPath + '/')) ?? [];
  if (candidates.length > 1) fail('Overlapping agent-door copy records; repair base-copies.json first.');
  if (candidates.length) {
   const copy = candidates[0], name = copy.path + origin.slice(copy.originPath.length), file = resolve(root, name);
   const inside = relative(root, file);
   if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) fail('Agent clause copy must stay inside this seed.');
   if (!copy.files?.[name]) return read(new URL('../modules/agent-door/CLAUSES.md', import.meta.url));
   if (!existsSync(file)) fail(`Restore the recorded agent clause source ${name} before syncing.`);
   const bytes = readFileSync(file);
   if (createHash('sha256').update(bytes).digest('hex') !== copy.files[name]) fail(`Recorded agent clause source ${name} has local edits; restore or refresh it first.`);
   return bytes.toString('utf8');
  }
 }
 return read(new URL('../modules/agent-door/CLAUSES.md', import.meta.url));
}

function definitions(source) {
 const blocks = [...source.matchAll(/^#### (BASE-AGENT-\d{3}) — ([^\n]+)\n([\s\S]*?)(?=^#{1,4} |$(?![\s\S]))/gm)];
 const result = blocks.map(([, id, title, body]) => ({ id, title, text: `#### ${id} — ${title}\n${body.trimEnd()}`, row: source.split('\n').find(line => line.startsWith(`| \`${id}\` |`)) }));
 for (const clause of result) {
  const acceptance = clause.text.split('\n**Acceptance.**\n')[1];
  const points = [...(acceptance ?? '').matchAll(/^(\d+)\. /gm)];
  if (!points.length || points.length > 8 || points.some((point, index) => Number(point[1]) !== index + 1)) fail(`${clause.id} needs one to eight consecutive acceptance points in its canonical source.`);
 }
 const ids = Array.from({ length: 13 }, (_, i) => `BASE-AGENT-${String(i + 1).padStart(3, '0')}`);
 if (result.map(item => item.id).join() !== ids.join() || result.some(item => !item.row)) fail('Canonical agent clauses must define BASE-AGENT-001 through 013 with initial Status rows.');
 return result;
}

function headings(lines) {
 let fence;
 return lines.flatMap((line, index) => {
  const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if (mark) { if (!fence) fence = mark[0]; else if (fence === mark[0]) fence = undefined; return []; }
  const match = !fence && /^(#{1,6}) ([^\r\n]+)/.exec(line);
  return match ? [{ index, level: match[1].length, title: match[2] }] : [];
 });
}

// contract-docs owns summary generation. Suppress only its three derived rows
// for structural validation while a contract is awaiting regeneration.
function withoutSummary(text) {
 return text.replace(/^(\| Clauses \| Done \| Partial \| Missing \| Total \|\r?\n[^\n]*\n)((?:\|[^\n]*\n)+)/m, (_, header, rows) => header + rows.replace(/[^\r\n]+/g, ''));
}

function synchronize(original, clauses) {
 const parsed = parseContract(withoutSummary(original));
 const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [], outline = headings(lines);
 const newline = original.includes('\r\n') ? '\r\n' : '\n';
 const edits = [], missing = [], changed = [];
 const target = outline.find(item => item.level === 2 && item.title === 'Target clauses');
 if (!target) fail('CONTRACT.md needs the standard ## Target clauses section. Convert the contract before syncing.');
 const targetEnd = outline.find(item => item.index > target.index && item.level <= 2)?.index ?? lines.length;
 for (const clause of clauses) {
  const old = parsed.clauses.find(item => item.id === clause.id);
  if (!old) { missing.push(clause); changed.push(`${clause.id} missing`); continue; }
  if (!lines[old.line - 1].startsWith('#### ') || old.kind !== 'target') fail(`${clause.id} must be a standard level-four Target clause before syncing; preserve its judgment when converting.`);
  const start = old.line - 1, end = outline.find(item => item.index > start)?.index ?? lines.length;
  const before = lines.slice(start, end).join(''), trailing = /\s*$/.exec(before)[0];
  const after = clause.text.replaceAll('\n', newline) + trailing;
  const row = lines[old.row - 1];
  // A changed canonical title updates only the title cell, never the seed's
  // kind, status, evidence or gap cells (or their original spacing).
  const updatedRow = row.replace(/^(\s*\|[^|]*\|)([^|]*)(\|.*)/, (_, first, title, rest) => first + title.replace(/\S(?:[\s\S]*\S)?/, clause.title) + rest);
  if (before !== after || row !== updatedRow) {
   changed.push(`${clause.id} stale`);
   edits.push({ start, end, text: after }, { start: old.row - 1, end: old.row, text: updatedRow });
  }
 }
 if (missing.length) {
  const delivered = outline.find(item => item.index > target.index && item.index < targetEnd && lines[item.index].trimEnd() === area);
  const agent = outline.find(item => item.index > target.index && item.index < targetEnd && item.level === 3 && item.title === 'Agent surface');
  const at = delivered ? outline.find(item => item.index > delivered.index && item.level <= 3)?.index ?? targetEnd : agent?.index ?? targetEnd;
  const text = (delivered ? '' : area + '\n\n') + missing.map(item => item.text).join('\n\n') + '\n\n';
  edits.push({ start: at, end: at, text: (at && !lines[at - 1].trim() ? '' : newline) + text.replaceAll('\n', newline) });
  const status = outline.find(item => item.level === 2 && item.title === 'Status');
  const header = lines.findIndex((line, index) => index > status?.index && /^\| Clause \| Title \| Kind \| Status \| Evidence \| Gap \|/.test(line));
  if (header < 0) fail('CONTRACT.md needs the standard Status clause table.');
  let end = header + 2;
  while (lines[end]?.trimStart().startsWith('|')) end++;
  edits.push({ start: end, end, text: (end && !lines[end - 1].endsWith('\n') ? newline : '') + missing.map(item => item.row).join(newline) + newline });
 }
 for (const edit of edits.sort((a, b) => b.start - a.start)) lines.splice(edit.start, edit.end - edit.start, edit.text);
 const text = lines.join('');
 parseContract(withoutSummary(text));
 return { text, changed };
}

function generator(root) {
 const agents = resolve(root, 'AGENTS.md');
 const declared = existsSync(agents) ? [...read(agents).matchAll(/^Lander-Regenerate:\s*(.+)$/gm)].map(match => match[1].trim()) : [];
 const command = declared.find(line => /contract-docs\.mjs\s+write\b/.test(line)) ?? 'node src/base/contract-docs.mjs write';
 if (!declared.some(line => /contract-docs\.mjs\s+write\b/.test(line)) && !existsSync(resolve(root, 'src/base/contract-docs.mjs'))) fail('No contract-docs generator found. Restore the seed\'s Lander-Regenerate contract generator before writing.');
 return { write: command, check: command.replace(/(contract-docs\.mjs\s+)write\b/, '$1check') };
}
function generate(command, root, env) {
 const result = spawnSync(command, { cwd: root, env, shell: true, stdio: 'inherit' });
 if (result.error || result.status !== 0) fail(`Contract generation failed: ${command}. Inspect the diff and repair the generator before committing.`);
}

export async function doorClausesCommand(args, env = process.env) {
 if (args.includes('--help') || args.includes('-h')) { console.log(clausesHelp); return 0; }
 let root = process.cwd(), mode;
 try {
  for (let i = 0; i < args.length; i++) {
   const arg = args[i];
   if (arg === '--cwd' && args[i + 1] && !args[i + 1].startsWith('-')) root = resolve(args[++i]);
   else if (['--write', '--check'].includes(arg) && !mode) mode = arg;
   else throw new RerError('invalid_arguments', clausesHelp, 2);
  }
  if (!mode) throw new RerError('invalid_arguments', clausesHelp, 2);
  root = resolve(root);
  const file = resolve(root, 'CONTRACT.md');
  if (!existsSync(file)) fail('No CONTRACT.md found. Run rer door clauses from the seed root or pass --cwd DIR.');
  const original = read(file), { text, changed } = synchronize(original, definitions(canonical(root)));
  if (changed.length) console.log(`Agent clauses: ${changed.join(', ')}.`);
  if (mode === '--check' && changed.length) return 1;
  const commands = generator(root);
  if (mode === '--write') {
   if (text !== original) writeFileSync(file, text);
   generate(commands.write, root, env);
  }
  generate(commands.check, root, env);
  console.log(changed.length ? `Synchronized ${changed.length} Base-delivered agent clauses; existing judgments preserved. Regenerate the source lock last.` : 'Base-delivered agent clauses are current; no clause changes.');
  return 0;
 } catch (error) {
  if (!(error instanceof RerError)) throw error;
  console.error(error.message); return error.exitCode;
 }
}
