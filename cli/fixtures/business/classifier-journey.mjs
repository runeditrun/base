import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classificationSchema } from './server.mjs';

const canary = 'fixture-raw-vendor-and-dns.example.invalid';
const valid = { vendor_id: 'uptimerobot', usage: 'both', confidence: 0.85 };
const help = '--tools --strict-mcp-config --setting-sources --output-format --json-schema --safe-mode --disable-slash-commands --no-session-persistence --sandbox --skip-git-repo-check --output-schema --ignore-user-config --ignore-rules --ephemeral --output-last-message';

export async function modelShim(home, name) {
 const bin = join(home, 'bin'); await mkdir(bin, { recursive: true });
 await writeFile(join(bin, name), `#!${process.execPath}
import { readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), home = process.env.HOME;
if (args.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0); }
if (args[0] === 'features') { console.log('hooks plugins apps memories shell_tool shell_snapshot view_image browser_use computer_use image_generation multi_agent multi_agent_v2 code_mode code_mode_host skip_host_skill_discovery'.split(' ').join('\\n')); process.exit(0); }
if (args[0] === 'mcp') { console.log(JSON.stringify([{ name: 'fixture_user_mcp' }, { name: 'fixture_managed_mcp' }])); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const schema = ${JSON.stringify(name)} === 'claude' ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
appendFileSync(join(home, 'model-calls.jsonl'), JSON.stringify({ args, prompt, schema, cwd: process.cwd(), files: readdirSync('.'), nodeOptions: process.env.NODE_OPTIONS ?? null, mcp: process.env.MCP_CONFIG ?? null, instructions: process.env.CODEX_INSTRUCTIONS ?? null }) + '\\n');
const answer = JSON.parse(readFileSync(join(home, 'model-answer.json'), 'utf8'));
if (answer.exit) { console.error(${JSON.stringify(canary)}); process.exit(7); }
const output = answer.malformed ? 'invalid-json' : JSON.stringify(answer.value);
if (${JSON.stringify(name)} === 'claude') console.log(answer.malformed ? output : JSON.stringify({ subtype: 'success', is_error: false, structured_output: answer.value }));
else writeFileSync(args[args.indexOf('--output-last-message') + 1], output);
`, { mode: 0o700 });
 return bin;
}

export async function classifierJourney({ directory, remote, cli, connect }) {
 for (const name of ['claude', 'codex']) {
  const home = join(directory, `classifier-${name}`), bin = await modelShim(home, name);
  const options = { path: `${bin}:${process.env.PATH}`, questionCli: name };
  const connected = await connect(home, remote, { ...options, terminal: true });
  assert.equal(connected.stdout.split('Questions CLI [').length - 1, 1, 'the owner chooses once per connection');
  const paired = remote.state.requests.filter(request => request.route.endsWith('/pair') && request.body.code).at(-1).body;
  assert.equal(paired.agent_kind, name);
  assert.ok(paired.capabilities.includes('classify.row') && paired.capabilities.includes(`classifier:${name}`));
  const state = JSON.parse(await readFile(join(home, '.rer/business/state.json'), 'utf8'));
  assert.deepEqual(state.classifier, { name, path: join(bin, name) });
  assert.deepEqual(state.capabilities, paired.capabilities);
  const status = await cli(home, ['business', 'status', '--json'], options);
  assert.equal(JSON.parse(status.stdout).questions_cli, name);
  for (const columns of [160, 43]) {
   const shown = await cli(home, ['business', 'status'], { ...options, terminal: true, columns });
   assert.equal(shown.code, 0); assert.ok(shown.stdout.includes(`Questions CLI: ${name}`));
  }
  const question = { tool_id: 'tool1', vendor_id: 'sentry', answer_schema: classificationSchema, raw_vendor: canary, dns: canary };
  const task = id => ({ task_id: id, kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question, instruction: canary });
  await writeFile(join(home, 'model-answer.json'), JSON.stringify({ value: valid }));
  remote.state.tasks = [task(`auto-${name}`)];
  const result = await cli(home, ['business', 'run', '--once'], options);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(remote.state.phase, 'done'); assert.deepEqual(remote.state.questionCompleted, valid);
  const calls = async () => (await readFile(join(home, 'model-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const [call] = await calls();
  assert.equal((await calls()).length, 1, 'one process per question');
  assert.deepEqual(call.files, [], 'model working directory is empty');
  assert.deepEqual(call.schema, classificationSchema);
  assert.equal(call.nodeOptions, null); assert.equal(call.mcp, null); assert.equal(call.instructions, null);
  assert.ok(!call.prompt.includes(canary) && !JSON.stringify(call.args).includes(canary), 'raw vendor, DNS and instructions never reach the model');
  for (const id of ['sentry', 'uptimerobot', 'none', 'product-dependency']) assert.ok(call.prompt.includes(id));
  if (name === 'claude') assert.deepEqual(call.args, ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json', '--json-schema', JSON.stringify(classificationSchema), '--safe-mode', '--disable-slash-commands', '--no-session-persistence']);
  else {
   const schemaPath = call.args[call.args.indexOf('--output-schema') + 1], outputPath = call.args[call.args.indexOf('--output-last-message') + 1];
   assert.ok(!schemaPath.startsWith(call.cwd + '/') && !outputPath.startsWith(call.cwd + '/'));
   assert.deepEqual(call.args, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-last-message', outputPath,
    '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'memories',
    '--disable', 'shell_tool', '--disable', 'shell_snapshot', '--disable', 'view_image',
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'code_mode', '--disable', 'code_mode_host',
    '-c', 'notify=[]', '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
    '-c', 'include_environment_context=false', '-c', 'include_environment_context_time=false',
    '-c', 'cloud.skills.enabled=false', '--enable', 'skip_host_skill_discovery',
    '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'web_search="disabled"',
    '-c', 'mcp_servers.fixture_user_mcp.enabled=false', '-c', 'mcp_servers.fixture_managed_mcp.enabled=false']);
  }
  const completed = () => remote.state.requests.filter(request => request.route.endsWith('/complete')).length;
  const baseline = completed();
  const invalid = [
   { value: { ...valid, vendor_id: 'outside-catalogue' } }, { value: { ...valid, confidence: 1.1 } },
   { value: { ...valid, usage: 'free text' } }, { value: { ...valid, extra: canary } }, { malformed: true }, { exit: true },
  ];
  for (const [index, answer] of invalid.entries()) {
   remote.state.tasks = [task(`bad-${name}-${index}`)];
   await writeFile(join(home, 'model-answer.json'), JSON.stringify(answer));
   const bad = await cli(home, ['business', 'run', '--once'], options);
   assert.equal(bad.code, 1); assert.ok(!bad.stdout.includes(canary) && !bad.stderr.includes(canary));
   assert.equal(completed(), baseline, 'invalid output is refused before completion');
   assert.equal(remote.state.released.reason, 'failed'); assert.equal(remote.state.phase, 'ready');
  }
  assert.equal((await calls()).length, 1 + invalid.length, 'failed judgements are never retried');
  remote.state.tasks = [{ ...task(`schema-${name}`), question: { ...question, answer_schema: { ...classificationSchema, description: canary } } }];
  assert.equal((await cli(home, ['business', 'run', '--once'], options)).code, 1);
  assert.equal((await calls()).length, 1 + invalid.length, 'untrusted schema metadata is released before a model starts');
  assert.equal(remote.state.released.reason, 'failed');
  await writeFile(join(home, 'model-answer.json'), JSON.stringify({ value: valid }));
  remote.state.tasks = [task(`refused-${name}`)]; remote.state.refuseQuestion = true;
  assert.equal((await cli(home, ['business', 'run', '--once'], options)).code, 1);
  assert.equal(remote.state.released.reason, 'failed'); assert.equal(remote.state.phase, 'ready');
  remote.state.refuseQuestion = false;
  const claimsBefore = remote.state.requests.filter(request => request.route.endsWith('/claim')).length;
  remote.state.tasks = [{ ...task('owner-classify'), runner: 'owner' }, { task_id: 'consent-auto', kind: 'consent.grant', state: 'ready', runner: 'owner' }];
  assert.equal((await cli(home, ['business', 'run', '--once'], options)).code, 0);
  assert.equal(remote.state.requests.filter(request => request.route.endsWith('/claim')).length, claimsBefore, 'owner-only tasks are never claimed');
  assert.equal((await calls()).length, 2 + invalid.length);
  assert.equal((await cli(home, ['business', 'disconnect'], options)).code, 0);
  assert.ok(!(await readdir(home)).includes('.rer'), 'classifier pairing and progress are removed');
 }
}
