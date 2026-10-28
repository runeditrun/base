// Host-only per-run fixture control. The app can neither call this function nor
// widen the declaration. Values cross only into the isolated provider adapter.
export function createFixtureControl(origins) {
 const values = new Map(); let count = 0, closed = false;
 return {
  set(origin, value) {
   if (closed || !origins.has(origin) || count >= 100) throw new TypeError('Fixture control requires an active run, a declared origin and at most 100 updates.');
   let json;
   try { json = JSON.stringify(value); } catch { /* Use a value-free diagnostic. */ }
   if (json === undefined || Buffer.byteLength(json) > 16_384) throw new TypeError('Fixture control requires JSON data of at most 16384 bytes.');
   values.set(origin, JSON.parse(json)); count++;
  },
  get(origin) { return structuredClone(values.get(origin)); },
  close() { closed = true; values.clear(); },
 };
}
