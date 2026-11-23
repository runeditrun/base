// What a person sees while `wrangler d1 migrations apply` runs. Wrangler redraws
// its whole migration table after every migration it applies, so 75 migrations
// print the first one's name 76 times and about 1.2 MB in all. The command's
// full output stays in the setup log and in failure diagnostics' source; the
// terminal and shared page get a count every ten migrations, anything that is
// not a table row, wrangler's own boilerplate or an earlier-seen line (warnings,
// errors), and one summary. Wrangler names the migration that failed only for
// some errors (a SQL syntax error is just its message), so the view names the
// first migration of the list that never showed a check mark when an error came.

const TABLE_LINE = /^[┌├└│─]/;
const STEP = 10;
// Wrangler's per-migration "🚣 37 commands executed successfully." differs every time, so repeats are not caught.
const PER_MIGRATION = /^🚣 \d+ commands? executed successfully\.?$/;
// What wrangler says around every apply, whatever it applies: its banner, where the database is, how to reach
// a remote one, the confirmation it answers itself in CI.
const BOILERPLATE = /^(\u26C5\uFE0F?\s*wrangler\b|Resource location:|Use --remote if you want|Migrations to be applied:|\? About to apply \d+ migration|Your database may not be available|🤖 Using fallback value|🌀 (Executing on|To execute on)|✅ No migrations to apply)/u;

export function isWranglerMigrationApply(command, args = [], { localOnly = false } = {}) {
 const words = [command, ...args].map(String);
 const tool = words.findIndex(word => /(^|[\\/])wrangler(\.js)?$/.test(word));
 if (tool < 0) return false;
 const rest = words.slice(tool + 1);
 const apply = rest.findIndex((word, index) => word === 'd1' && rest[index + 1] === 'migrations' && rest[index + 2] === 'apply');
 if (apply < 0) return false;
 if (!localOnly) return true;
 return rest.includes('--local') && !rest.some((word, index) =>
  /^--(?:remote|preview|no-local)(?:$|=)/.test(word) ||
  word.startsWith('--local=') || (word === '--local' && rest[index + 1] === 'false'));
}

// One view per command: write(text) returns the text to show, end() the rest.
// The summary names the log that keeps wrangler's full output: { log }.
export function wranglerMigrationView({ log } = {}) {
 let pending = '', total = 0, announced = 0, failed = false, errored = false, transient = false, otherError = false;
 const applied = new Set(), seen = new Set(), names = [];
 const shown = [];
 const progress = () => `Applying migrations ${applied.size}/${Math.max(total, applied.size)}`;
 const line = text => {
  if (TABLE_LINE.test(text)) {
   if (!text.startsWith('│')) return;
   const cells = text.split('│').slice(1, -1).map(cell => cell.trim());
   if (cells[0] === 'name') return;
   if (cells.length === 1) { total += 1; if (!names.includes(cells[0])) names.push(cells[0]); return; }
   if (cells[1].includes('❌')) { failed = true; shown.push(`Migration ${cells[0]} failed.`); return; }
   if (cells[1].includes('✅') && !applied.has(cells[0])) {
    applied.add(cells[0]);
    if (applied.size % STEP === 0 && applied.size > announced) { announced = applied.size; shown.push(progress()); }
   }
   return;
  }
  const trimmed = text.trim();
  if (/\[ERROR\]/.test(trimmed)) {
   errored = true;
   if (/^(?:✘\s+)?\[ERROR\] internal error; reference = [a-z\d]+$/i.test(trimmed)) transient = true;
   else if (!/^✘ \[ERROR\] Migration .+ failed with the following errors:$/.test(trimmed)) otherError = true;
  }
  if (!trimmed || PER_MIGRATION.test(trimmed) || BOILERPLATE.test(trimmed) || seen.has(trimmed)) return;
  seen.add(trimmed);
  shown.push(text);
 };
 const drain = () => { const text = shown.length ? shown.join('\n') + '\n' : ''; shown.length = 0; return text; };
 return {
  write(text) {
   const lines = (pending + text).split('\n');
   pending = lines.pop();
   for (const item of lines) line(item);
   return drain();
  },
  end() {
   if (pending) { line(pending); pending = ''; }
   if (errored && !failed && names[applied.size]) shown.push(`Migration ${names[applied.size]} failed.`);
   if (applied.size) shown.push(`Applied ${applied.size} migration${applied.size === 1 ? '' : 's'}.${log ? ` Full output: ${log}` : ''}`);
   return drain();
  },
  facts: () => ({ migrationsApplied: applied.size }),
  retryable: () => transient && !otherError,
 };
}
