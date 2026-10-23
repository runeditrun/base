import {execFileSync} from 'node:child_process';

// One Git process for a released source graph, rather than one per module.
export function gitBlobs(repo, entries) {
  const objects = [...new Set(entries.map(entry => entry.object))];
  if (!objects.length) return new Map();
  const output = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: objects.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
    env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const blobs = new Map();
  let offset = 0;
  for (const object of objects) {
    const end = output.indexOf(10, offset);
    const [returned, type, length] = output.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(length);
    if (returned !== object || type !== 'blob' || !Number.isSafeInteger(size)) throw Error('Cannot read released migration source.');
    offset = end + 1;
    blobs.set(object, output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return new Map(entries.map(entry => [entry.name, blobs.get(entry.object)]));
}
