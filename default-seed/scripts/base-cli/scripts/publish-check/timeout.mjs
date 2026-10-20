import { readFileSync } from 'node:fs';

export const timeoutBounds = Object.freeze(JSON.parse(readFileSync(new URL('./timeout.json', import.meta.url), 'utf8')));

// Release requires whole seconds; publish-check also accepts fractional
// seconds, which its existing deadline test and standalone callers use.
export function parseTimeoutSeconds(value, { integer = false } = {}) {
  const seconds = Number(value);
  if ((integer && !/^\d+$/.test(String(value))) || !String(value).trim() ||
      !(seconds > 0 && seconds <= timeoutBounds.max)) {
    throw new RangeError(`Scan timeout must be ${integer ? 'integer ' : ''}seconds from ${integer ? '1' : 'above 0'} to ${timeoutBounds.max}.`);
  }
  return seconds;
}
