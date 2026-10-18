import { execute } from './model-process.mjs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { classification, classificationPrompt, validateClassification } from './classification.mjs';
import { claudeEnvironment, codexEnvironment, detectionEnvironment, trustedExecutable } from './model-env.mjs';
import { copyCodexCredentials, instructionProbe, onlyProbe, returnRefreshedCredentials, smallestCodexModel } from './codex-home.mjs';

const codexIsolation = [
 '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'memories',
 '--disable', 'shell_tool', '--disable', 'shell_snapshot', '--disable', 'view_image',
 '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
 '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'code_mode', '--disable', 'code_mode_host',
 '-c', 'notify=[]', '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
 '-c', 'include_environment_context=false', '-c', 'include_environment_context_time=false',
 '-c', 'cloud.skills.enabled=false', '--enable', 'skip_host_skill_discovery',
 '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'web_search="disabled"',
];

const required = {
 claude: ['--tools', '--strict-mcp-config', '--setting-sources', '--output-format', '--json-schema', '--model', '--max-budget-usd', '--safe-mode', '--disable-slash-commands', '--no-session-persistence'],
 codex: ['--sandbox', '--skip-git-repo-check', '--output-schema', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-last-message', '--model'],
};
const modelShape = /^[a-z0-9][a-z0-9.-]{0,63}$/;

// Probe one candidate in a throwaway home without credentials. Returns the
// pinned cheaper-tier model it accepts, or null when it is unsupported.
async function probe(name, path) {
 const temporary = await mkdtemp(join(tmpdir(), 'rer-business-cli-help-'));
 try {
  await mkdir(join(temporary, 'codex'), { mode: 0o700 });
  const run = (args, limit) => execute(path, args, { cwd: temporary, timeout: 10_000, env: detectionEnvironment(temporary), limit });
  const help = await run(name === 'codex' ? ['exec', '--help'] : ['--help']);
  if (!required[name].every(flag => help.includes(flag))) return null;
  if (name === 'claude') return 'sonnet';
  const known = new Set((await run(['features', 'list'])).split('\n').map(line => line.trim().split(/\s+/)[0]));
  if (codexIsolation.some((arg, index) => ['--disable', '--enable'].includes(arg) && !known.has(codexIsolation[index + 1]))) return null;
  return smallestCodexModel(await run(['debug', 'models', '--bundled'], 16 * 1024 * 1024));
 } catch { return null; /* Unsupported or unavailable CLIs are not advertised. */ }
 finally { await rm(temporary, { recursive: true, force: true }); }
}

// Absolute PATH entries only, first trusted match per CLI.
export async function detectClassifiers() {
 const found = await Promise.all(Object.keys(required).map(async name => {
  for (const directory of (process.env.PATH ?? '').split(':')) {
   if (!isAbsolute(directory)) continue;
   const path = join(directory, name);
   if (!(await trustedExecutable(path))) continue;
   const model = await probe(name, path);
   return model ? [name, { path, model }] : null;
  }
  return null;
 }));
 return Object.fromEntries(found.filter(Boolean));
}

// The exec command has no global MCP-off switch. List servers with the same
// private CODEX_HOME exec uses (so only managed or system servers remain),
// without starting them, and disable each one explicitly.
async function disabledMcp(path, options) {
 let servers;
 try {
  servers = JSON.parse(await execute(path, ['mcp', 'list', '--json', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps'], { ...options, timeout: 10_000 }));
  if (!Array.isArray(servers) || servers.length > 1000 || servers.some(server => typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(server.name))) throw Error();
 } catch { throw Error('Business classifier MCP isolation could not be established. Task released.'); }
 return servers.flatMap(server => ['-c', `mcp_servers.${server.name}.enabled=false`]);
}

async function runCodex(classifier, task, { temporary, schemaPath, outputPath, signal, beforeModel }) {
 const home = join(temporary, 'home'), codexHome = join(home, '.codex'), cwd = join(temporary, 'work');
 await mkdir(codexHome, { recursive: true, mode: 0o700 });
 const copy = await copyCodexCredentials(codexHome), options = { cwd, signal, env: codexEnvironment(home, codexHome) };
 const mcp = await disabledMcp(classifier.path, options);
 let rendered;
 try { rendered = await execute(classifier.path, ['debug', 'prompt-input', ...codexIsolation, ...mcp, instructionProbe], { ...options, timeout: 10_000, limit: 1024 * 1024 }); }
 catch { throw Error('Business classifier could not check Codex instructions. Task released.'); }
 if (!onlyProbe(rendered)) throw Error('Business classifier refused: Codex would load AGENTS.md or other inherited instructions. Task released.');
 await beforeModel();
 try {
  await execute(classifier.path, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-last-message', outputPath, '--model', classifier.model, ...codexIsolation, ...mcp],
   { ...options, input: classificationPrompt(task) });
 } finally { await returnRefreshedCredentials(copy, codexHome); }
 try {
  if ((await stat(outputPath)).size > 65536) throw Error();
  return JSON.parse(await readFile(outputPath, 'utf8'));
 } catch { throw Error('Business classifier returned an invalid result. Task released.'); }
}

async function runClaude(classifier, task, { schema, cwd, signal, beforeModel, maxBudgetUsd }) {
 await beforeModel();
 const stdout = await execute(classifier.path, ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
  '--model', classifier.model, '--max-budget-usd', String(maxBudgetUsd), '--safe-mode', '--disable-slash-commands', '--no-session-persistence'], { cwd, signal, env: claudeEnvironment(), input: classificationPrompt(task) });
 try {
  const result = JSON.parse(stdout);
  if (result.is_error || result.subtype !== 'success') throw Error();
  return result.structured_output;
 } catch { throw Error('Business classifier returned an invalid result. Task released.'); }
}

// beforeModel runs immediately before the model process starts, so the
// hourly limit counts model questions only.
export async function classify(task, classifier, { signal, beforeModel, maxBudgetUsd }) {
 const { schema } = classification(task);
 if (!classifier || !Object.hasOwn(required, classifier.name) || !isAbsolute(classifier.path) || typeof classifier.model !== 'string' || !modelShape.test(classifier.model))
  throw Error('Business classifier is unavailable. Reconnect to choose a supported CLI.');
 if (!(await trustedExecutable(classifier.path))) throw Error('Business classifier executable is missing or writable by others. Reconnect to choose a supported CLI.');
 const temporary = await mkdtemp(join(tmpdir(), 'rer-business-classifier-'));
 try {
  const cwd = join(temporary, 'work'); await mkdir(cwd, { mode: 0o700 });
  const schemaPath = join(temporary, 'schema.json'), outputPath = join(temporary, 'answer.json');
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600, flag: 'wx' });
  const answer = classifier.name === 'claude'
   ? await runClaude(classifier, task, { schema, cwd, signal, beforeModel, maxBudgetUsd })
   : await runCodex(classifier, task, { temporary, schemaPath, outputPath, signal, beforeModel });
  return validateClassification(task, answer);
 } finally { await rm(temporary, { recursive: true, force: true }); }
}
