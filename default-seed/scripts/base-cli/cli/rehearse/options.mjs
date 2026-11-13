import {resolve} from 'node:path';
import {invalid} from '../errors.mjs';

export const rehearseHelp = `Usage: rer rehearse [--cwd DIR] [--ref REF] [--json] [FLAGS]

Rehearse the first managed build in a fresh two-commit copy, outside this checkout.
Runs every declared setup, build, verify and artifact operation, in that order,
continuing after failures. No provider credentials are passed to the operations.

  --ref REF                    Committed source to rehearse (default HEAD).
  --repository OWNER/REPO      Upstream identity (default rer-project.json sourceRepository).
  --workflow-ref WORKFLOW@SHA  Platform trusted workflow pin, required only when the seed
                               has no dispatch-only .github/workflows/rer-managed.yml.
  --operation-timeout-seconds N  Deadline for each operation (default 900).
  --timeout-seconds N          Overall deadline, including preparation (default 3600).
  --keep                      Keep the scratch repository and its private HOME for diagnosis.
  --json                      One version-1 result event with every operation, cause,
                               child exit/signal, elapsed seconds and captureLog path.
  --help                      Show help without running anything.

Exit 0: all operations pass; 1: any FAIL or NOT REACHED; 2: invalid arguments;
3: source/declaration/scratch preparation failed; 124: overall timeout;
130/143: interrupted by SIGINT/SIGTERM. Per-operation timeouts are FAIL (exit 1).
The redacted capture log survives cleanup. NOT REACHED names a missing prerequisite
following a failed operation, or the overall deadline/interruption that prevented a start.
Operations are trusted seed code and can install packages and contact the network.
This is a local build rehearsal; it does not attest, upload or deploy an artifact.

Heavy work: signers and seed lanes must run through .tools/heavy-slot.py:
  python3 -I /path/to/.tools/heavy-slot.py --remote auto -- rer rehearse --cwd SEED
Use a clean committed worktree when routing remotely; the selected source must be local
on that runner. Only declared operations may acquire dependencies over the network.
`;

export function rehearseOptions(args) {
 const options = {cwd:process.cwd(), ref:'HEAD', operationTimeoutSeconds:900, timeoutSeconds:3600};
 const seen = new Set();
 for (let index=0; index<args.length; index++) {
  const flag=args[index];
  if (seen.has(flag)) throw invalid(`Repeated flag ${flag}.`); seen.add(flag);
  if (['--json','--keep','--help','--non-interactive'].includes(flag)) options[flag.slice(2)] = true;
  else if (['--cwd','--ref','--repository','--workflow-ref','--operation-timeout-seconds','--timeout-seconds'].includes(flag)) {
   const value=args[++index];if (!value || value.startsWith('--')) throw invalid(`Provide a value for ${flag}.`);
   const key=flag.slice(2).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
   if (flag.endsWith('seconds')) {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>86400) throw invalid(`${flag} takes integer seconds from 1 to 86400.`);
    options[key]=Number(value);
   } else options[key]=value;
  } else throw invalid(`Unsupported rehearsal flag ${flag}. Run rer rehearse --help.`);
 }
 options.cwd=resolve(options.cwd);
 if (options.ref.startsWith('-')) throw invalid('--ref must name a Git commit or reference.');
 return options;
}
