import { createRequire } from 'node:module';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { registrationReader } from './check-tests-reader.mjs';

const code = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const ignored = new Set(['node_modules', '.git', '.rer', '.seed', '.wrangler', '.cache', 'dist', 'build', 'coverage']);
const limit = 10000;

// No declaration means no parser prerequisite, filesystem traversal or new gate.
export async function checkTestBudget(root) {
 let declaration;
 try { declaration = await readFile(join(root, 'test-budget.json'), 'utf8'); }
 catch (error) { if (error.code === 'ENOENT') return; return failure('Cannot read test-budget.json.'); }
 let budget;
 try { budget = JSON.parse(declaration); } catch { return failure('test-budget.json must contain valid JSON.'); }
 if (!budget || budget.version !== 1 || !Number.isSafeInteger(budget.cap) || budget.cap < 0 ||
     Object.keys(budget).some(key => !['version', 'cap', 'platforms'].includes(key)) ||
     !Array.isArray(budget.platforms) || !budget.platforms.length ||
     new Set(budget.platforms).size !== budget.platforms.length ||
     budget.platforms.some(platform => !['linux', 'darwin', 'win32'].includes(platform)))
  return failure('test-budget.json requires version 1, a nonnegative integer cap and distinct supported platforms (linux, darwin, win32); count exemptions are not supported.');
 let ts;
 try { ts = createRequire(join(root, 'package.json'))('typescript'); }
 catch { return failure('Test budget checking requires the checkout\'s installed typescript package. Install the declared dependencies first.', budget.cap); }
 try {
  const files = [], excluded = new Set();
  // These are recorded copies, not filename heuristics for edition-owned tests.
  const inventory = join(root, 'scripts/base-cli/inventory.json');
  try {
   const record = JSON.parse(await readFile(inventory, 'utf8'));
   for (const path of Object.keys(record.files ?? {})) excluded.add(resolve(root, 'scripts/base-cli', path));
   for (const path of Object.keys(record.onboardingFiles ?? {})) excluded.add(resolve(root, 'scripts/base-onboarding', path));
  } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot read the recorded CLI copy inventory.'); }
  try {
   const record = JSON.parse(await readFile(join(root, 'base-copies.json'), 'utf8'));
   if (record.schemaVersion !== 1 || !Array.isArray(record.copies)) throw Error('Invalid copy record');
   for (const copy of record.copies) for (const path of Object.keys(copy.files ?? {})) {
    if (!Object.hasOwn(copy.adapted ?? {}, path)) excluded.add(resolve(root, path));
   }
  } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot read base-copies.json for test ownership.'); }
  async function walk(directory) {
   for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (excluded.has(path)) continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && code.test(entry.name)) files.push(path);
    if (files.length > limit) throw Error('Test budget source discovery exceeds the bounded reader limit.');
   }
  }
  await walk(root);
  const assertEntries = await verificationScripts(root, files);
  const configurations = [];
  for (const platform of budget.platforms) {
   const reader = registrationReader(ts, { root, platform, excluded, limit });
   await reader.prepare(files);
   const result = await reader.count(files, assertEntries);
   configurations.push({ platform, ...result });
  }
  const diagnostics = [...new Set(configurations.flatMap(config => config.diagnostics))].sort();
  const total = Math.max(...configurations.map(config => config.total));
  // Contributions come from one real supported configuration, never a mixture.
  const filesReport = configurations.find(config => config.total === total).files;
  const ok = !diagnostics.length && total <= budget.cap;
  const contributions = filesReport.map(file => `${file.file}: ${file.count}`).join(', ');
  return { ok, total: diagnostics.length ? null : total, cap: budget.cap, files: filesReport, configurations: configurations.map(config => ({ ...config, total: config.diagnostics.length ? null : config.total })),
   diagnostics, ...(!ok ? { message: diagnostics.length ? diagnostics.join('\n') : `Test budget exceeded by ${total - budget.cap}: ${total} registrations, cap ${budget.cap}. Contributions: ${contributions}.` } : {}) };
 } catch (error) { return failure(error.message, budget.cap); }
}

function failure(message, cap = null) {
 return { ok: false, total: null, cap, files: [], configurations: [], diagnostics: [message], message };
}

// Read command declarations, never execute a shell, module or package script.
// Scripts with assertions count only when reachable from verification commands.
async function verificationScripts(root, files) {
 let pkg = {};
 try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 const commands = Object.entries(pkg.scripts ?? {}).filter(([name]) => /^(?:test|verify)(?::|$)/.test(name)).map(([, command]) => command);
 try {
  const plan = JSON.parse(await readFile(join(root, 'verification.json'), 'utf8'));
  for (const rows of Object.values(plan)) if (Array.isArray(rows)) for (const row of rows) commands.push(...(row.commands ?? []));
 } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot read verification.json for test entry points.'); }
 const seen = new Set(), entries = new Set();
 const names = new Map(files.map(file => [relative(root, file).split(sep).join('/'), file]));
 while (commands.length) {
  const command = commands.pop();
  if (typeof command !== 'string' || seen.has(command)) continue;
  seen.add(command);
  for (const match of command.matchAll(/\b(?:pnpm|npm)\s+(?:run\s+)?([\w:-]+)/g)) if (pkg.scripts?.[match[1]]) commands.push(pkg.scripts[match[1]]);
  // Quoted sh command payloads and queued wrappers still contain these tokens.
  for (const match of command.matchAll(/(?:^|[\s"'])((?:\.?\.?\/)?[\w./*?{}-]+\.(?:[cm]?[jt]s|[jt]sx))(?=$|[\s"'])/g)) {
   const pattern = match[1].replace(/^\.\//, '');
   const escaped = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
   const regex = new RegExp(`^${escaped}$`);
   for (const [name, file] of names) if (regex.test(name)) entries.add(file);
  }
 }
 // Ensure a directory masquerading as a script never enters the reader.
 for (const entry of entries) if (!(await lstat(entry)).isFile()) entries.delete(entry);
 return entries;
}
