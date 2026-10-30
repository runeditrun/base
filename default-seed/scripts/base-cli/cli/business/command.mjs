import { setupCommand } from './setup-command.mjs';
import { scanCommand } from './scan-command.mjs';
import { connect } from './connect.mjs';
import { vendorKey, disconnect, status } from './local-commands.mjs';
import { next, answer, token } from './questions.mjs';
import { run } from './supervisor.mjs';
import { describe } from './errors.mjs';

const usage = `Set up your business: rer business connect
Business keeps your business name, logo and brand colour together for the apps
that support shared Business settings. Choose what to share in your browser.

Advanced commands (Usage: rer business VERB)
  setup --origin URL --session-file FILE --confirm-demo
                                 Provision the synthetic Run your business demo
                                 --hosting managed|assisted|self_host (default: managed)
                                 --wait-seconds 0..240 (default: 240); --json
  scan [DIR...] [--json]          Names-only local discovery
  connect [--code CODE] [--origin URL]
                                 Pair this computer, waiting until the owner approves in the browser
                                 (up to the code's 10 minutes); run it again to resume
                                 Connect carries the Business name into local apps
  run [--once]                   Work this computer's tasks: the folder scan the owner allows, then
                                 vendor exports into each app's import door (a preview the owner
                                 approves), catch-ups (applied within the owner's standing approval,
                                 else reviewed by the owner) and the final archive the app keeps and
                                 test-restores; the vendor key stays in OS credential storage. Says
                                 what it is doing and waiting for; applies the owner's choices at
                                 each check-in
  next                           Apply the owner's choices, then return one templated question, the
                                 agent's next step, an owner step with its browser link (freeze,
                                 rollback card, cancellation; never agent work), or nothing yet
                                 within 60 seconds
  answer ID VENDOR USAGE [CONFIDENCE]
                                 Catalog vendor or none; uses, sells, both, product-dependency
  vendor-key add|remove VENDOR   Keep a read-only vendor key in OS credential storage; the owner
                                 types it in their own terminal, never in chat or a command
  token                          MCP headersHelper output; send directly to the MCP client
  status [--json]                Pairing, service, current task and checkpoint
  disconnect                     Revoke this computer, then remove local credentials and additions;
                                 inside an agent sandbox it names the one command that finishes
Vendors: sentry, uptimerobot, pagerduty, calendly (with a read-only key); sorry (its public page,
no key). Owner approvals stay in the browser.
State lives in $RER_BUSINESS_STATE_DIR when set, otherwise in ~/.rer/business.
In an agent sandbox that writes only inside its working folder, use RER_BUSINESS_STATE_DIR="$PWD/.rer-business".
`;

const verbHelp = {
 connect: `Usage: rer business connect [--code CODE] [--origin URL]
Pair this computer with Business, waiting for the owner to approve the comparison
number in their browser (up to the code's 10 minutes). Run again to resume.

  --code CODE    Pairing code created in the Business browser.
  --origin URL   Business platform address (default: https://app.runeditrun.com).
Without a code, prints the path to create one or resumes this computer's pairing.
Carries the Business name into local app files for supporting apps to read.
Choose this computer's permissions and background service in the browser.
`,
 token: `Usage: rer business token
Print an MCP Authorization header object for this computer's paired Business.
Send this headersHelper output directly to the MCP client; it contains a credential.
Requires an existing pairing: rer business connect.
`,
};

export async function businessCommand(argv) {
 if (argv[0] === 'setup') return setupCommand(argv.slice(1));
 if (Object.hasOwn(verbHelp, argv[0]) && argv.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(verbHelp[argv[0]]); return 0; }
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
   if (options.code !== undefined && !/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(options.code)) return invalid();
   await connect(options);
  } else if (verb === 'vendor-key' && args.length === 2) await vendorKey(...args);
  else if (verb === 'answer' && [3, 4].includes(args.length)) await answer(...args);
  else if (verb === 'run' && (!args.length || args.length === 1 && args[0] === '--once')) await run({ once: args[0] === '--once' });
  else if (verb === 'status' && args.length === 1 && args[0] === '--json') await status({ json: true });
  else if (!args.length && ['next','token','status','disconnect'].includes(verb)) await ({ next, token, status, disconnect })[verb]();
  else return invalid();
  return 0;
 } catch (error) {
  // Name the cause: the server's reason, the local cause or this CLI's own
  // explanation. Bearers are redacted from every message.
  process.stderr.write(describe(error) + '\n'); return error?.exitCode ?? 1;
 }
}
function invalid() { process.stderr.write(usage); return 2; }
