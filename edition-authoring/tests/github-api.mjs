import fs from 'node:fs';
import path from 'node:path';

// Substitute only the existing gh API process edge. Every application command,
// tree/blob validator and migration decision still runs in the shipped package.
export function githubApiEdge(tools, responses) {
  fs.mkdirSync(tools, {recursive: true});
  const answers = path.join(tools, 'responses.json'), requests = path.join(tools, 'requests.jsonl');
  const save = values => fs.writeFileSync(answers, JSON.stringify(values));
  save(responses);
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const values = JSON.parse(fs.readFileSync(__dirname + '/responses.json', 'utf8'));
const endpoint = process.argv[3]?.replace(/^repos\\/[^/]+\\/[^/]+\\//, '');
fs.appendFileSync(__dirname + '/requests.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (!Object.hasOwn(values, endpoint)) { console.error('Fixture GitHub API: unknown or unrelated commit (HTTP 404)'); process.exit(1); }
process.stdout.write(JSON.stringify(values[endpoint]));
`, {mode: 0o755});
  return {save, requests: () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse) : []};
}
