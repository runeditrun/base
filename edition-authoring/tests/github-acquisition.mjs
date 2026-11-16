import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Observe real Git transfers and reject any REST call. Tests redirect only
// the network edge through Git's URL rewrite to a real local object store.
export function githubAcquisitionEdge(tools) {
  fs.mkdirSync(tools, {recursive: true});
  const git = execFileSync('which', ['git'], {encoding: 'utf8'}).trim();
  const requests = path.join(tools, 'requests.jsonl'), failure = path.join(tools, 'fail-fetch');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(tools, 'gh'), `#!/bin/sh
printf '%s\\n' '["api"]' >> ${quote(requests)}
exit 1
`, {mode: 0o755});
  fs.writeFileSync(path.join(tools, 'git'), `#!/bin/sh
for argument do
 if [ "$argument" = fetch ]; then
  printf '%s\\n' '["fetch"]' >> ${quote(requests)}
  if [ -f ${quote(failure)} ]; then
   echo 'private transport diagnostic (HTTP 503)' >&2
   exit 1
  fi
 fi
done
exec ${quote(git)} "$@"
`, {mode: 0o755});
  return {
    failFetch(on) { if (on) fs.writeFileSync(failure, ''); else fs.rmSync(failure, {force: true}); },
    requests: () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}
