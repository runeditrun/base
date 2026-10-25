import { stemmer } from './vendor/stemmer.mjs';

// Function words identify grammar, not a heading. Topic words stay corpus-driven.
const stop = new Set('a all an and any are as at be been being by can could did do does for from had has have how i if in into is it its me my of on or our should that the their them there these they this those to was we were what when where which who why will with would you your each every some another both either neither other same such certain several please get need want use using'.split(' '));
export const words = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export const processTerm = term => stop.has(term) ? null : stemmer(term);
export const terms = text => words(text).map(processTerm).filter(Boolean);
export const searchOptions = {
  fields: ['heading', 'title', 'path', 'text'],
  storeFields: ['href', 'titlePath', 'text', 'hash'],
  tokenize: words, processTerm,
};

// Restore ordinary one-edit spelling errors before stemming: a misspelt suffix
// can otherwise prevent Porter from recognizing the same word's root.
const oneEdit = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
    || a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1);
};
export function corpusLanguage(documents) {
  const raw = new Map(), frequency = new Map();
  for (const doc of documents) {
    const tokens = words(doc.titlePath.join(' ') + ' ' + doc.text);
    for (const token of new Set(tokens)) raw.set(token, (raw.get(token) ?? 0) + 1);
    for (const token of new Set(tokens.map(processTerm).filter(Boolean))) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  const correct = token => {
    if (raw.has(token) || token.length < 4) return token;
    const matches = [...raw].filter(([word]) => oneEdit(token, word)).sort((a, b) => b[1] - a[1]);
    return matches.length && (!matches[1] || matches[0][1] > matches[1][1]) ? matches[0][0] : token;
  };
  return { prepare: text => words(text).map(correct).join(' '),
    known: term => frequency.has(term),
    weight: term => Math.log(1 + documents.length / (1 + (frequency.get(term) ?? 0))) };
}
