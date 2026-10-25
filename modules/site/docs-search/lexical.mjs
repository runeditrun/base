import { stemmer } from './vendor/stemmer.mjs';

// Function words identify grammar, not a heading. Topic words stay corpus-driven.
const stop = new Set('a an and are as at be been being by can could did do does for from had has have how i if in into is it its me my of on or our should that the their them there these they this those to was we were what when where which who why will with would you your'.split(' '));
export const words = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export const processTerm = term => stop.has(term) ? null : stemmer(term);
export const terms = text => words(text).map(processTerm).filter(Boolean);
export const searchOptions = {
  fields: ['heading', 'title', 'path', 'text'],
  storeFields: ['href', 'titlePath', 'text', 'hash'],
  tokenize: words, processTerm,
};
