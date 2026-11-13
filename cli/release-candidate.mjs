import {resolve} from 'node:path';
import {prepareCandidate} from '../modules/release/candidate.mjs';

export const candidateHelp = `Usage: rer release candidate --tag vVERSION-PRERELEASE [--cwd DIR] [--json]

Prepare stage-only version metadata in one local commit on the caller's checkout.
Updates only version in seed.json, package.json and RELEASE.json; requires a clean
checkout with matching committed versions and the caller's Git commit identity.
Repeating the same tag is a no-op. Accepts the current version core or the next
patch core. Stable tags require the normal release metadata path.

The output version always contains a SemVer pre-release suffix (for example
0.4.25-rc1); production consumers must refuse pre-release tags. Stage only: do not
publish a GitHub Release, Site or registry entry, or expose it to outside users.
Creates no tag, artifact, push, signature or deployment. Existing producer gates
still apply to the returned commit; run its two-commit rehearsal before stage use.
`;

export async function candidateCommand(args) {
 try {
  let cwd=process.cwd(), tag; const seen=new Set();
  for (let index=0; index<args.length; index++) {
   const flag=args[index];
   if (seen.has(flag)) throw Error(`Repeated candidate flag ${flag}.`); seen.add(flag);
   if (flag==='--help') {console.log(candidateHelp);return 0;}
   if (flag==='--json' || flag==='--non-interactive') continue;
   if (!['--cwd','--tag'].includes(flag) || !args[index+1]?.trim() || args[index+1].startsWith('--')) throw Error('Use rer release candidate --tag vVERSION-PRERELEASE [--cwd DIR] [--json].');
   const value=args[++index]; if(flag==='--cwd')cwd=resolve(value);else tag=value;
  }
  console.log(JSON.stringify(prepareCandidate(cwd, tag), null, 2));return 0;
 } catch(error) {console.error(error.message);return 2;}
}
