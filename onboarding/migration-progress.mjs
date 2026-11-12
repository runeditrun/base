// What a person sees while `wrangler d1 migrations apply` runs. Wrangler redraws
// its whole migration table after every migration it applies, so 75 migrations
// print the first one's name 76 times and about 1.2 MB in all. The command's
// full output stays in the setup log and in failure diagnostics' source; the
// terminal and shared page get a count every ten migrations, anything that is
// not a table row or an earlier-seen line (warnings, errors), and one summary.

const TABLE_LINE = /^[┌├└│─]/;
const STEP = 10;
// Wrangler's per-migration "🚣 37 commands executed successfully." differs every time, so repeats are not caught.
const PER_MIGRATION = /^🚣 \d+ commands? executed successfully\.?$/;

export function isWranglerMigrationApply(command, args = []) {
 const words = [command, ...args].map(String);
 const tool = words.findIndex(word => /(^|[\\/])wrangler(\.js)?$/.test(word));
 if (tool < 0) return false;
 const rest = words.slice(tool + 1);
 return rest.some((word, index) => word === 'd1' && rest[index + 1] === 'migrations' && rest[index + 2] === 'apply');
}

// One view per command: write(text) returns the text to show, end() the rest.
export function wranglerMigrationView() {
 let pending = '', total = 0, announced = 0;
 const applied = new Set(), seen = new Set();
 const shown = [];
 const progress = () => `Applying migrations ${applied.size}/${Math.max(total, applied.size)}`;
 const line = text => {
  if (TABLE_LINE.test(text)) {
   if (!text.startsWith('│')) return;
   const cells = text.split('│').slice(1, -1).map(cell => cell.trim());
   if (cells[0] === 'name') return;
   if (cells.length === 1) { total += 1; return; }
   if (cells[1].includes('❌')) { shown.push(`Migration ${cells[0]} failed.`); return; }
   if (cells[1].includes('✅') && !applied.has(cells[0])) {
    applied.add(cells[0]);
    if (applied.size % STEP === 0 && applied.size > announced) { announced = applied.size; shown.push(progress()); }
   }
   return;
  }
  const trimmed = text.trim();
  if (!trimmed || PER_MIGRATION.test(trimmed) || seen.has(trimmed)) return;
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
   if (applied.size) shown.push(`Applied ${applied.size} migration${applied.size === 1 ? '' : 's'}.`);
   return drain();
  },
  facts: () => ({ migrationsApplied: applied.size }),
 };
}
