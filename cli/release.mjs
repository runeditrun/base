import { releaseVerb } from './contract.mjs';
import { parseTimeoutSeconds, timeoutBounds } from '../scripts/publish-check/timeout.mjs';

// Preserve release's accepted parser, producer, receipt and validation exits.
const releaseHelp = `Usage: rer release --repo DIR --project OWNER/NAME --repository GITHUB_URL --output NEW_DIR [FLAGS]

Produce local artifacts using the exact source commit's green GitHub Verify,
frozen installation, local build and publication checks.
Without --tag, write a preview. This command never pushes, uploads or deploys.

  --repo DIR             Source Git repository.
  --project OWNER/NAME   Project identity recorded by the edition.
  --repository GITHUB_URL
                         Credential-free https://github.com/<owner>/<repository> destination.
  --output NEW_DIR       New output directory outside the source repository.
  --ref REF              Selected committed source (default: HEAD).
  --public-base REF      Public history as GIT_URL#BRANCH for exact-source scans;
                         defaults to this public repository's default branch.
  --tag [vVERSION]       Prepare source artifacts and create or adopt an annotated tag;
                         an explicit tag must match the committed release version.
  --dry-run              Run the real gates and suppress local tag creation.
  --local-verify         Run the seed's full verification locally instead of
                         requiring its exact commit's green GitHub Verify.
  --verify-workflow NAME_OR_FILE
                         Override the seed's declared GitHub verification workflow
                         by name or file (case-insensitive).
  --scan-timeout-seconds N
                         Publication scan deadline in integer seconds (1..${timeoutBounds.max}).
                         Omit to use the scanner default.
  --clean-history        Prepare a parentless public export.
  --onto GITHUB_URL#BRANCH
                         Prepare a public child of the destination's current branch;
                         cannot be combined with --clean-history.
  --env-file FILE        Credential file for publication inspection.
  --allow-placeholder-mark
                         Release while the seed still carries Base's placeholder
                         mark; the receipt records the files.
  --no-queue             Bypass the job queue only in the original CI environment.
  --help                 Print this help without performing release work.

Signing and receipt commands:
  rer release sign --artifact DIR (--key-file FILE | --key-stdin) [--scope test|rer] [--publisher NAMESPACE]
  rer release receipt --artifact DIR --anchors FILE [--environment test] [--after VERSION:SHA256]
  rer release keygen --scope test|rer --publisher NAMESPACE --github-owner LOGIN --github-owner-id ID --anchor-out FILE
    [--not-before YYYY-MM-DDTHH:MM:SSZ] [--not-after YYYY-MM-DDTHH:MM:SSZ]
    [--unsigned-through PROJECT:VERSION ...]

Signing scope defaults to rer; receipt environment defaults to production.
Signing publisher defaults to the project prefix; use --publisher for a different publisher.
Key generation requires non-terminal stdout; --key-stdin requires non-terminal stdin.
`;
const signingHelp = {
 sign: `Usage: rer release sign --artifact DIR (--key-file FILE | --key-stdin) [--scope test|rer]

Write a detached signature for a produced release artifact and print, without
running it, the GitHub upload command. Signing scope defaults to rer;
--key-stdin requires non-terminal stdin.`,
 receipt: `Usage: rer release receipt --artifact DIR --anchors FILE [--environment test] [--after VERSION:SHA256]

Verify a signed release artifact against local anchors, offline. The receipt
environment defaults to production.`,
 keygen: `Usage: rer release keygen --scope test|rer --publisher NAMESPACE --github-owner LOGIN --github-owner-id ID --anchor-out FILE
  [--not-before YYYY-MM-DDTHH:MM:SSZ] [--not-after YYYY-MM-DDTHH:MM:SSZ]
  [--unsigned-through PROJECT:VERSION ...]

Write a public anchor to --anchor-out and, on success, its private key to
stdout, which must not be a terminal.`,
};

export async function dispatchRelease(args) {
 // --help never performs release work, wherever it appears.
 if (args.includes('--help')) { console.log(signingHelp[args[0]] ?? releaseHelp); return 0; }
 if (Object.hasOwn(releaseVerb.subcommands, args[0])) return (await import('../modules/release/signing-cli.mjs')).dispatchSigning(args[0], args.slice(1));
 try {
  const options = {};
  for (let index = 0; index < args.length; index++) {
   if(args[index]==='--no-queue'){}
   else if (args[index] === '--tag') options.tag = args[index + 1]?.startsWith('v') ? args[++index] : true;
   else if (args[index] === '--scan-timeout-seconds') {
    try { options.scanTimeoutSeconds = parseTimeoutSeconds(args[++index], { integer: true }); }
    catch (error) { throw Error(`--scan-timeout-seconds: ${error.message}`); }
   }
   else if (args[index] === '--clean-history') options.cleanHistory = true;
   else if (args[index] === '--dry-run') options.dryRun = true;
   else if (args[index] === '--allow-placeholder-mark') options.allowPlaceholderMark = true;
   else if (args[index] === '--local-verify') options.localVerify = true;
   else if (['--repo', '--project', '--repository', '--output', '--ref', '--env-file', '--onto', '--public-base', '--verify-workflow'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--'))
    options[args[index] === '--env-file' ? 'envFile' : args[index] === '--public-base' ? 'publicBase' : args[index] === '--verify-workflow' ? 'verifyWorkflow' : args[index].slice(2)] = args[++index];
   else throw Error('Invalid release arguments');
  }
  if(args.includes('--no-queue')){const {shared}=await import('./shared.mjs');const {commandPolicy}=await shared('queue.mjs');const policy=await commandPolicy();try{if(!policy.ci)throw Error('Original CI required');}finally{await policy.close();}}
  if (!options.repo || !options.output) throw Error('Release requires --repo and --output');
  const { release } = await import('../modules/release/produce.mjs');
  const receipt = await release(options);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt.status === 'BLOCKED' ? 1 : 0;
 } catch (error) {
  console.error(error?.message || 'Release failed during argument, source or artifact validation. No release completed.');
  return 2;
 }
}
