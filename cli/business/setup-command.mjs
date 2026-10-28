import { DemoRefusal, safeCode, sessionCookie, setupDemo } from './setup.mjs';

const usage = `Usage: rer business setup --origin URL --session-file PATH
       --hosting self_host|managed|assisted --confirm-demo-policy [--json]
Provision the synthetic demo through the ordinary Business routes.
PATH must be an owner-only 0600 JSON file containing only {"cookie":"<session cookie>"}.
Both output modes print the platform receipt as JSON. Exit 0 means complete;
exit 2 means dependencies are still required; exit 1 names a refusal.
`;

export async function setupCommand(argv) {
 if (argv.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 let cookie;
 // The session is read from the protected file only. Even a remote echo must
 // not turn the cookie or its individual values into terminal output.
 const redact = value => {
  const secrets = cookie ? [cookie, ...cookie.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()).filter(Boolean)] : [];
  const text = item => secrets.reduce((result, secret) => result.split(secret).join('[credential]'), item);
  const clean = item => typeof item === 'string' ? text(item)
   : Array.isArray(item) ? item.map(clean)
   : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [text(key), clean(entry)])) : item;
  return JSON.stringify(clean(value), null, 2);
 };
 try {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
   const key = argv[index];
   const boolean = new Map([['--confirm-demo-policy', 'confirmPolicy'], ['--json', 'json']]).get(key);
   if (boolean && options[boolean] === undefined) { options[boolean] = true; continue; }
   const name = new Map([['--origin', 'origin'], ['--session-file', 'sessionFile'], ['--hosting', 'hosting']]).get(key);
   if (!name || options[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new DemoRefusal('demo_arguments_invalid', 400);
   options[name] = argv[++index];
  }
  if (!options.origin || !options.sessionFile) throw new DemoRefusal('demo_arguments_invalid', 400);
  if (!options.hosting) throw new DemoRefusal('demo_hosting_required', 400);
  if (!options.confirmPolicy) throw new DemoRefusal('demo_policy_confirmation_required', 400);
  try { cookie = await sessionCookie(options.sessionFile); }
  catch (error) { throw error instanceof DemoRefusal ? error : new DemoRefusal('demo_session_file_invalid', 400); }
  const receipt = await setupDemo({ ...options, cookie });
  process.stdout.write(redact(receipt) + '\n');
  return receipt.complete ? 0 : 2;
 } catch (error) {
  process.stderr.write(redact({ code: safeCode(error.code), status: error instanceof DemoRefusal ? error.status : null }) + '\n');
  return 1;
 }
}
