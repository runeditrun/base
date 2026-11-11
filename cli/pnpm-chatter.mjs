// A failing `pnpm run` script is wrapped in pnpm's own lines: a banner before it and
// "ELIFECYCLE Command failed" after it. rer states the failure itself, once, so a
// step's terminal output can leave those lines out. The step's log keeps every byte.
const header = /^> \S*@\S* \S+ \S.*$/, elifecycle = /^\s*ELIFECYCLE\s+Command failed with exit code \d+\.\s*$/;

export function withoutPnpmChatter(write) {
 let banner = false;
 return text => {
  const lines = String(text).split('\n'), last = lines.pop();
  const kept = [];
  for (const line of lines) {
   if (banner) {
    // The banner's command line, then the blank line that closes it.
    if (/^> .+$/.test(line)) continue;
    banner = false;
    if (line === '') continue;
   }
   if (elifecycle.test(line)) continue;
   if (header.test(line)) { banner = true; continue; }
   kept.push(line);
  }
  const out = [...kept.map(line => line + '\n'), last].join('');
  if (out) write(out);
 };
}
