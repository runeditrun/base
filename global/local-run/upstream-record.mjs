import { git, text } from './process.mjs';
import { failure } from './error.mjs';

export const recordPath = 'rer-upstream.json';
const keys = ['schema', 'repository', 'tag', 'commit'];
const invalid = () => failure('refused', `${recordPath} is invalid; restore its recorded release identity before upgrading.`);

export function parseRecord(bytes) {
 try {
  if (Buffer.byteLength(bytes) > 65536) throw invalid();
  const source = bytes.toString(), value = JSON.parse(source);
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
    value.schema !== 1 || typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value.repository) ||
    value.repository.split('/').some(part => ['.', '..'].includes(part)) ||
    typeof value.tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.tag) ||
    typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) throw invalid();
  // Consume every JSON string, including values, before identifying keys. This
  // catches duplicate keys even when their spellings use JSON escapes.
  const members = [...source.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)]
   .filter(match => /^\s*:/.test(source.slice(match.index + match[0].length)))
   .map(match => JSON.parse(match[0]));
  if (members.length !== keys.length || new Set(members).size !== keys.length) throw invalid();
  return { repository: value.repository, tag: value.tag, commit: value.commit };
 } catch { throw invalid(); }
}

export function recordBytes({ repository, tag, commit }) {
 const value = { schema: 1, repository, tag, commit };
 parseRecord(JSON.stringify(value));
 return JSON.stringify(value, null, 2) + '\n';
}

export async function readRecord(checkout) {
 const entry = (await git(checkout, ['ls-tree', '-z', 'HEAD', '--', recordPath])).stdout;
 if (!entry) return null;
 const match = /^100(?:644|755) blob ([a-f0-9]{40})\trer-upstream\.json\0$/.exec(entry);
 if (!match || Number(await text(checkout, ['cat-file', '-s', match[1]])) > 65536) throw invalid();
 return parseRecord((await git(checkout, ['cat-file', 'blob', match[1]], { maxBuffer: 65536 })).stdout);
}

// Replace the root entry in Git's object database, leaving the owner's index
// and working files untouched until the ordinary fast-forward switch.
export async function recordTree(checkout, tree, identity) {
 const oid = await text(checkout, ['hash-object', '-w', '--stdin'], { input: recordBytes(identity) });
 const entries = (await git(checkout, ['ls-tree', '-z', tree])).stdout.split('\0')
  .filter(entry => entry && entry.slice(entry.indexOf('\t') + 1) !== recordPath);
 entries.push(`100644 blob ${oid}\t${recordPath}`);
 return text(checkout, ['mktree', '-z'], { input: entries.join('\0') + '\0' });
}
