// rer prompt <repo> [--guide CODE]: the one block a person pastes into Claude
// Code or Codex to have it run the app. It reads and writes nothing and needs
// no project, no install and no network; the wording of its shared lines is
// the onboarding hand-off's own.
import { promptVerb } from '../../cli/contract.mjs';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';
import { credentialRule, sameMachine } from '../../onboarding/agent-handoff.mjs';
import { repoArguments } from '../cli/repository.mjs';
import { invalid } from '../../cli/errors.mjs';
import { takeGuide } from './code.mjs';

const installer = 'curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev';
const plain = /^[\w./:@=+-]+$/;

export function agentPrompt(repo, code) {
 const line = `${installer} ${plain.test(repo) ? repo : shellQuote(repo)}${code ? ` --guide ${code}` : ''}`;
 return `Run ${repo} on this computer with Run Edit Run's rer.
${sameMachine} Run this one command and wait for it to finish; a first start can take up to 10 minutes, so give the shell tool at least that long:

${line}

It installs rer, fetches the app, sets it up and starts it, then prints RER_READY. When it does, run: rer open
That opens the app, signed in, on this computer. If rer is not on PATH yet, use ~/.local/bin/rer.

Rules:
- Never print, paste or repeat the RER_OPEN link: it is a credential. Open the app with rer open, never with that link.
- ${credentialRule}
- If the command fails, stop and tell me ${code ? 'the phase and error_code on its RER_GUIDE_FAILED line' : 'which step failed and what rer printed'}. Do not retry in a loop or change anything else.
`;
}

export async function promptCommand(args) {
 if (args.includes('--help')) {
  process.stdout.write(`Usage: rer prompt <repo> [--guide CODE]\n${promptVerb.effects}\n`);
  return 0;
 }
 try {
  const { argv: rest, code } = takeGuide(['dev', ...args]), [repo, ...extra] = rest.slice(1);
  const flag = rest.slice(1).find(arg => arg.startsWith('-') && !promptVerb.flags.includes(arg));
  if (flag) throw invalid(`Unsupported flag ${/^--[a-zA-Z-]{1,40}$/.test(flag) ? flag : '(invalid)'} for prompt. Run rer prompt --help.`);
  if (!repo || extra.length) throw invalid('rer prompt takes the app\'s repository, for example: rer prompt just-every/run-slate --guide CODE');
  repoArguments(['dev', repo]); // the same repository forms rer dev takes
  process.stdout.write(agentPrompt(repo, code));
  return 0;
 } catch (error) {
  process.stderr.write(error.message + '\n');
  return typeof error.exitCode === 'number' ? error.exitCode : 1;
 }
}
