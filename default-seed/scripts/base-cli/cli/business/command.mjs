import { scanCommand } from './scan-command.mjs';
import { connect } from './connect.mjs';
import { vendorKey, disconnect, status } from './local-commands.mjs';
import { next, answer, token } from './questions.mjs';
import { run } from './supervisor.mjs';

const usage = `Usage: rer business VERB
  scan [DIR...] [--json]          Names-only local discovery
  connect --code CODE [--origin URL]
                                 Pair, compare a number in your browser, then opt in to a service
  run [--once]                   Work supported deterministic tasks (protocol integration pending)
  next                           Return one templated question or nothing yet within 60 seconds
  answer ID ENUM                 Submit an agent classification: uses, sells, unknown
  vendor-key add|remove VENDOR   Keep a vendor key in OS credential storage
  token                          MCP headersHelper output; send directly to the MCP client
  status [--json]                Pairing, service, current task and checkpoint
  disconnect                     Remove local service, credentials and added permissions
Vendors: sentry, uptimerobot, pagerduty, calendly. Owner approvals stay in the browser.
`;

export async function businessCommand(argv) {
 if (!argv.length || argv[0] !== 'scan' && argv.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 if (argv[0] === 'scan') return scanCommand(argv);
 try {
  const [verb, ...args] = argv;
  if (verb === 'connect') {
   const options = {};
   for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--code', '--origin'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, name.slice(2))) return invalid();
    options[name.slice(2)] = args[index + 1];
   }
   if (typeof options.code !== 'string' || !/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(options.code)) return invalid();
   await connect(options);
  } else if (verb === 'vendor-key' && args.length === 2) await vendorKey(...args);
  else if (verb === 'answer' && args.length === 2) await answer(...args);
  else if (verb === 'run' && (!args.length || args.length === 1 && args[0] === '--once')) await run({ once: args[0] === '--once' });
  else if (verb === 'status' && args.length === 1 && args[0] === '--json') await status({ json: true });
  else if (!args.length && ['next','token','status','disconnect'].includes(verb)) await ({ next, token, status, disconnect })[verb]();
  else return invalid();
  return 0;
 } catch (error) {
  // All messages emitted here are authored by this CLI, never server/vendor or
  // OS diagnostics. Unexpected errors can contain paths or credential material.
  const message = error instanceof Error && /^(?:Business |This computer |This item |Choose |OS credential |Enter |Credential |A terminal |Installing |Changing |Keeping |Could not (?:reach the Business|keep this Mac|start the Business|stop the Business|reload the Business)|Claude |The Business |A Business |Another process |Run rer )/.test(error.message)
   ? error.message : 'Business command failed. Check pairing, OS credential storage and browser task requirements.';
  process.stderr.write(message + '\n'); return 1;
 }
}
function invalid() { process.stderr.write(usage); return 2; }
