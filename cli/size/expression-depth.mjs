import { dmlParts } from './dml-parts.mjs';
import { tokenize } from './from-items.mjs';

// SQLite adds the heights of nested expressions along its name-resolution walk,
// so a statement's depth can be measured with the compiler it already runs on.
// node:sqlite (Node 22.20) has no limit setter and keeps SQLite's default of
// 1000, so each part is wrapped under a chain of k additions:
//   SELECT (1+1+…+1) + EXISTS (SELECT 1 FROM (<part>))
// It compiles while k + depth(part) fits the limit. `SELECT 1` has depth 1, so
// its largest k calibrates the sum, and a part's depth is calibration + 1 - k.
const TOO_LARGE = /Expression tree is too large/;
const chain = k => k <= 1 ? '1' : Array(k).fill('1').join('+');
const wrapped = (part, k) => `SELECT (${chain(k)}) + EXISTS (SELECT 1 FROM (${part}))`;

export class MeasureError extends Error {}

export function depthMeter(db) {
  // null when it compiles; the message when it does not.
  const failure = sql => { try { db.prepare(sql); return null; } catch (error) { return error.message; } };
  const fits = (part, k) => {
    const message = failure(wrapped(part, k));
    if (message && !TOO_LARGE.test(message)) throw new MeasureError(message);
    return !message;
  };
  // The largest k that fits, by binary search; below the first k tried, there is none.
  const largestPadding = (part, high) => {
    let low = 2;
    if (!fits(part, low)) return 1;
    if (fits(part, high)) throw new MeasureError(`the part compiles with ${high} additions above it`);
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (fits(part, mid)) low = mid; else high = mid;
    }
    return low;
  };
  const calibration = largestPadding('SELECT 1', 4000);
  const partsOf = sql => dmlParts(sql, tokenize(sql));
  return {
    parts: partsOf,
    // One compile per part: is the statement's depth at most `limit`?
    atMost: (parts, limit) => parts.every(part => fits(part, calibration + 1 - limit)),
    // The exact depth: a search per part. A part too deep to compile at all reports the calibration, the most it can show.
    exact: parts => Math.max(...parts.map(part => calibration + 1 - largestPadding(part, calibration + 2))),
  };
}
