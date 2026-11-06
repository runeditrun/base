import { setupCommand } from './setup-command.mjs';
import { scanCommand } from './scan-command.mjs';
import { connect } from './connect.mjs';
import { disconnect, status } from './local-commands.mjs';
import { next, answer, done, token } from './questions.mjs';
import { run } from './supervisor.mjs';
import { describe } from './errors.mjs';
import { identifier, originUrl } from './api.mjs';

const usage = `Set up your business: rer business connect
Business keeps your business name, logo and brand colour together for the apps
that support shared Business settings. Choose what to share in your browser.

Advanced commands (Usage: rer business VERB)
  setup --origin URL --session-file FILE --confirm-demo
                                 Create the synthetic demo company's Business and its profile
                                 --hosting managed|assisted|self_host (default: managed); --json
  scan [DIR...] [--json]          Names-only local discovery
  connect --business ID [--origin URL] [--timeout SECONDS]
                                 Print a code and link for the owner to approve in a signed-in browser
                                 Older Business pages: connect --code CODE [--origin URL]
                                 Connect carries the Business name into local apps
  run [--once]                   Work this computer's tasks: the folder scan the owner allows. Says what
                                 it is doing and what it waits for; applies the owner's choices at each
                                 check-in
  next                           Apply the owner's choices, then return one templated question, the
                                 agent's next step (a Move in step names the seed's Move in page, what the
                                 seed takes and how to export), an owner step with its browser link, or
                                 nothing yet within 60 seconds
  answer ID VENDOR USAGE [CONFIDENCE]
                                 Catalog vendor or none; uses, sells, both, product-dependency
  done ID --note TEXT            Finish a Move in step once the owner has the data in the seed
  token                          MCP headersHelper output; send directly to the MCP client
  status [--json]                Pairing, service, current task and checkpoint
  disconnect                     Revoke this computer, then remove local credentials and additions;
                                 inside an agent sandbox it names the one command that finishes
State lives in $RER_BUSINESS_STATE_DIR when set, otherwise in ~/.rer/business.
In an agent sandbox that writes only inside its working folder, use RER_BUSINESS_STATE_DIR="$PWD/.rer-business".
`;

const verbHelp = {
 setup: `Usage: rer business setup --origin URL --session-file FILE --confirm-demo [--hosting managed|assisted|self_host] [--json]
Create the Business for the synthetic demo company in setup-company.json and save
its profile, through the platform's owner routes. A repeat reuses that Business and
changes nothing when its profile already matches. It provisions no seeds.

  --origin URL          Platform address to create the Business on.
  --session-file FILE   The signed-in session file Business setup reads: an owned,
                        regular 0600 file containing rer_session=VALUE or
                        __Host-rer_session=VALUE. Symlinks are refused.
                        The session is sent only as the platform Cookie header.
  --confirm-demo        Required confirmation to create the synthetic demo company.
  --hosting MODE        managed (default), assisted or self_host.
  --json                Print the JSON receipt (also the default).
  --help, -h            Show this help without reading the session file.
Exits 0 when the Business exists with that profile; 1 with a named {code} on stderr.
`,
 run: `Usage: rer business run [--once]
Work this computer's tasks (the folder scan the owner allows) and check in every
25 seconds until stopped. Steps for this computer's agent, such as a seed's Move in,
are shown by rer business next. --once returns after one check-in.
Exits 0 completed, idle or waiting for the owner; 1 failed; 2 usage.
`,
 connect: `Usage: rer business connect --business ID [--origin URL] [--timeout SECONDS]
Pair this computer with a Business. Prints a code and a link: the owner opens the
link in a signed-in browser, checks the code and approves. Waits for that (up to
the code's 10 minutes), then keeps the credential in OS credential storage.
  --business ID      The Business to join; the Connect prompt names it.
  --origin URL       Business platform address (default: https://app.runeditrun.com).
  --timeout SECONDS  Wait at most this long, then exit 75 with the pairing kept;
                     run the same command again to keep waiting (same code).
  --code CODE        Older Business pages: redeem a code made in the browser.
Exits 0 connected, 1 ended (refused, expired or failed), 2 usage, 75 still waiting.
`,
 token: `Usage: rer business token
Print an MCP Authorization header object for this computer's paired Business.
Send this headersHelper output directly to the MCP client; it contains a credential.
Requires an existing pairing: rer business connect.
`,
};

export async function businessCommand(argv) {
 if (Object.hasOwn(verbHelp, argv[0]) && argv.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(verbHelp[argv[0]]); return 0; }
 if (argv[0] === 'setup') return setupCommand(argv.slice(1));
 if (!argv.length || argv[0] !== 'scan' && argv.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 if (argv[0] === 'scan') return scanCommand(argv);
 try {
  const [verb, ...args] = argv;
  if (verb === 'connect') {
   const options = {};
   for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--code', '--origin', '--business', '--timeout'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, name.slice(2))) return invalid();
    options[name.slice(2)] = args[index + 1];
   }
   if (options.code !== undefined && !/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(options.code)) return invalid();
   if (options.code !== undefined && (options.business !== undefined || options.timeout !== undefined)) return invalid();
   if (options.timeout !== undefined) {
    if (!/^\d{1,3}$/.test(options.timeout) || Number(options.timeout) > 900) return invalid();
    options.timeout = Number(options.timeout);
   }
   try {
    if (options.business !== undefined) identifier(options.business);
    if (options.origin !== undefined && options.business !== undefined) originUrl(options.origin);
   } catch { return invalid(); }
   if (options.origin !== undefined && options.code === undefined && options.business === undefined) originUrl(options.origin);
   await connect(options);
  } else if (verb === 'done' && args.length === 3) await done(...args);
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
