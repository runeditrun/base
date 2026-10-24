// `--guide CODE`: the code the Run guide page minted, so that page can show this
// launch's progress. Only its shape is checked here, from the contract (the
// platform mints 24 URL-safe characters): 16 to 64 letters, digits, - or _.
// The code is the only identifier a guide event is sent under, and a code that
// fails the rule is never echoed back.
import { invalid } from '../../cli/errors.mjs';

const guideCodeShape = /^[A-Za-z0-9_-]{16,64}$/;

const refusal = () => invalid('--guide takes the code the Run guide page shows (16 to 64 letters, digits, - or _). Copy the command from that page again, or run the same command without --guide.');

// Take `--guide CODE` out of a `dev` invocation. Only the global launcher knows
// the flag, so no pinned dispatcher ever sees it. Other verbs are returned
// unchanged and refuse the flag as any unknown one.
export function takeGuide(argv) {
 if (argv[0] !== 'dev') return { argv };
 const rest = [];
 let code;
 for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--') { rest.push(...argv.slice(i)); break; }
  if (argv[i] !== '--guide') { rest.push(argv[i]); continue; }
  if (code !== undefined) throw invalid('Use --guide only once.');
  code = argv[++i];
  if (typeof code !== 'string' || !guideCodeShape.test(code)) throw refusal();
 }
 return { argv: rest, code };
}
