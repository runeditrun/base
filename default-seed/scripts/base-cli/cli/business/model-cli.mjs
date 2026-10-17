import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classification, classificationPrompt, validateClassification } from './classification.mjs';

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
 claude: ['--tools', '--strict-mcp-config', '--setting-sources', '--output-format', '--json-schema', '--safe-mode', '--disable-slash-commands', '--no-session-persistence'],
 codex: ['--sandbox', '--skip-git-repo-check', '--output-schema', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-last-message'],
};

// Pass authentication and transport settings, never the supervisor's Node
// preload, agent instructions, hooks, MCP configuration or vendor credentials.
function environment() {
 const env = {};
 for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
 }
 return env;
}

async function execute(path, args, { cwd, input, signal, timeout = 120_000, env = environment() }) {
 signal?.throwIfAborted();
 return new Promise((resolveRun, reject) => {
  const child = execFile(path, args, { cwd, env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
   if (error) reject(Error('Business classifier failed, timed out or was canceled. Task released.'));
   else resolveRun(stdout);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
 });
}

export async function detectClassifiers() {
 const found = await Promise.all(Object.keys(required).map(async name => {
  for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
   const path = resolve(directory, name);
   try { if (!(await stat(path)).isFile()) continue; await access(path, constants.X_OK); }
   catch { continue; }
   const temporary = await mkdtemp(join(tmpdir(), 'rer-business-cli-help-'));
   try {
    if (name === 'codex') await mkdir(join(temporary, 'codex'), { mode: 0o700 });
    const help = await execute(path, name === 'codex' ? ['exec', '--help'] : ['--help'], { cwd: temporary, timeout: 10_000, env: { ...environment(), HOME: temporary, CODEX_HOME: join(temporary, 'codex') } });
    if (!required[name].every(flag => help.includes(flag))) return null;
    if (name === 'codex') {
     const features = await execute(path, ['features', 'list'], { cwd: temporary, timeout: 10_000, env: { ...environment(), HOME: temporary, CODEX_HOME: join(temporary, 'codex') } });
     const known = new Set(features.split('\n').map(line => line.trim().split(/\s+/)[0]));
     if (codexIsolation.some((arg, index) => ['--disable', '--enable'].includes(arg) && !known.has(codexIsolation[index + 1]))) return null;
    }
    return [name, path];
   } catch { /* Unsupported or unavailable CLIs are not advertised. */ }
   finally { await rm(temporary, { recursive: true, force: true }); }
   return null;
  }
  return null;
 }));
 return Object.fromEntries(found.filter(Boolean));
}

// The exec command has no global MCP-off switch. Inspect configuration without
// starting servers, then explicitly disable every named server (including
// managed/system configuration). Never persist or expose transport settings.
async function disabledMcp(path, cwd, signal) {
 let servers;
 try {
  servers = JSON.parse(await execute(path, ['mcp', 'list', '--json', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps'], { cwd, signal, timeout: 10_000 }));
  if (!Array.isArray(servers) || servers.length > 1000 || servers.some(server => typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(server.name))) throw Error();
 } catch { throw Error('Business classifier MCP isolation could not be established. Task released.'); }
 return servers.flatMap(server => ['-c', `mcp_servers.${server.name}.enabled=false`]);
}

export async function classify(task, classifier, { signal } = {}) {
 const { schema } = classification(task);
 if (!classifier || !Object.hasOwn(required, classifier.name) || !isAbsolute(classifier.path)) throw Error('Business classifier is unavailable. Reconnect to choose a supported CLI.');
 const temporary = await mkdtemp(join(tmpdir(), 'rer-business-classifier-'));
 try {
  const cwd = join(temporary, 'work'); await mkdir(cwd, { mode: 0o700 });
  const schemaPath = join(temporary, 'schema.json'), outputPath = join(temporary, 'answer.json');
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600, flag: 'wx' });
  const mcp = classifier.name === 'codex' ? await disabledMcp(classifier.path, cwd, signal) : [];
  const args = classifier.name === 'claude'
   ? ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--safe-mode', '--disable-slash-commands', '--no-session-persistence']
   : ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-last-message', outputPath, ...codexIsolation, ...mcp];
  const stdout = await execute(classifier.path, args, { cwd, input: classificationPrompt(task), signal });
  let answer;
  try {
   if (classifier.name === 'claude') {
    const result = JSON.parse(stdout);
    if (result.is_error || result.subtype !== 'success') throw Error();
    answer = result.structured_output;
   } else {
    if ((await stat(outputPath)).size > 65536) throw Error();
    answer = JSON.parse(await readFile(outputPath, 'utf8'));
   }
  } catch { throw Error('Business classifier returned an invalid result. Task released.'); }
  return validateClassification(task, answer);
 } finally { await rm(temporary, { recursive: true, force: true }); }
}
