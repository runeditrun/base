// Estimate the two Node file workers separately, including the other stages
// sharing each job. Timing weights affect placement only, never the inventory.
export function balanceFiles(files, { seconds, fallback, overhead, isolated = [], fixed = {} }) {
  const shards = Object.keys(overhead);
  const duration = file => seconds[file] ?? fallback;
  const serial = files.filter(file => isolated.includes(file));
  const regular = files.filter(file => !serial.includes(file))
    .sort((a, b) => duration(b) - duration(a) || a.localeCompare(b));
  let best, shortest = Infinity;
  // There are just two isolated CLI files. Try all 4² owners: placing both in
  // one batch-heavy partition can leave another free for a long regular file.
  function plan(owners) {
    if (owners.length < serial.length) {
      for (const shard of shards) plan([...owners, shard]);
      return;
    }
    const groups = Object.fromEntries(shards.map(shard => [shard, []]));
    const load = Object.fromEntries(shards.map(shard => [shard, [overhead[shard], overhead[shard]]]));
    serial.forEach((file, index) => {
      const shard = owners[index];
      groups[shard].push(file);
      load[shard] = load[shard].map(value => value + duration(file));
    });
    for (const file of regular) {
      const owner = shards.find(shard => fixed[shard]?.includes(file));
      const shard = owner ?? shards.reduce((lightest, next) => Math.min(...load[next]) < Math.min(...load[lightest]) ? next : lightest);
      const worker = load[shard][0] <= load[shard][1] ? 0 : 1;
      load[shard][worker] += duration(file);
      groups[shard].push(file);
    }
    const longest = Math.max(...Object.values(load).flat());
    if (longest < shortest) { best = groups; shortest = longest; }
  }
  plan([]);
  return best;
}
