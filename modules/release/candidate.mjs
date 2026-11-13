import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {git, inspectSource} from './source.mjs';

const core = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const identifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const version = new RegExp(`^${core}(?:-${identifier}(?:\\.${identifier})*)?$`);
const candidate = new RegExp(`^v${core}-${identifier}(?:\\.${identifier})*$`);
const files = ['seed.json', 'package.json', 'RELEASE.json'];

// A candidate uses the current core or the immediately following patch.
// Minor and major releases keep their normal explicit metadata preparation.
function allowedCore(current, requested) {
 const [major, minor, patch] = current;
 return [current, [major, minor, patch + 1]]
  .some(parts => parts.every((part, index) => part === requested[index]));
}

export function prepareCandidate(cwd, tag) {
 const wanted = candidate.exec(tag ?? '');
 if (!wanted) throw Error('Candidate requires --tag vMAJOR.MINOR.PATCH-PRERELEASE; stable tags use the normal release metadata path.');
 const repo = git(resolve(cwd), 'rev-parse', '--show-toplevel').toString().trim();
 const source = inspectSource(repo, 'HEAD'), current = version.exec(source.seed.version);
 const requested = wanted.slice(1, 4).map(Number), previous = current?.slice(1, 4).map(Number);
 if (!previous || ![...previous, ...requested].every(Number.isSafeInteger) || !allowedCore(previous, requested))
  throw Error('Candidate must be a pre-release of the current version or its next patch version.');
 const next = tag.slice(1);
 if (source.seed.version === next) return {stageOnly:true, tag, version:next, commit:source.commit, changed:false};
 // Preserve the caller's configured identity; the source reader deliberately
 // ignores global Git config, so it must not be used to create this commit.
 const commitGit = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {stdio:['ignore','pipe','pipe']});
 commitGit('var', 'GIT_AUTHOR_IDENT'); commitGit('var', 'GIT_COMMITTER_IDENT');
 const changes = files.map(path => {
  const bytes = source.bytes(path).toString(), value = JSON.parse(bytes);
  // Preserve all other metadata and the caller's formatting. The committed
  // top-level version is the only JSON value that may change.
  const before = JSON.stringify(value);
  let depth = 0, result = '', end = 0;
  const strings = /"(?:[^"\\]|\\.)*"|[{}\[\]]/g;
  for (const token of bytes.matchAll(strings)) {
   if (['{','['].includes(token[0])) depth++;
   else if (['}',']'].includes(token[0])) depth--;
   else if (depth === 1 && JSON.parse(token[0]) === 'version') {
    const tail = bytes.slice(token.index + token[0].length), match = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(tail);
    if (!match) continue;
    const start = token.index + token[0].length + match[0].length - match[1].length;
    result += bytes.slice(end, start) + JSON.stringify(next); end = start + match[1].length;
   }
  }
  result += bytes.slice(end);
  value.version = next;
  if (before === JSON.stringify(value) || JSON.stringify(JSON.parse(result)) !== JSON.stringify(value)) throw Error(`Cannot update only ${path} version.`);
  return {path, bytes:result};
 });
 for (const {path, bytes} of changes) writeFileSync(resolve(repo, path), bytes);
 git(repo, 'add', '--', ...files);
 commitGit('commit', '-m', `Prepare stage-only candidate ${tag}`);
 return {stageOnly:true, tag, version:next, commit:git(repo, 'rev-parse', 'HEAD').toString().trim(), changed:true};
}
