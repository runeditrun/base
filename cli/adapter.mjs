import { jobsVerb, verbs, releaseFlags } from './contract.mjs';

// Declarative seed boundary; all spawning, secret custody and readiness live in
// the existing onboarding kit. No adapter gets a second executor.
export function commandAdapter(lifecycle, options) {
 const result = { version: 1, ...lifecycle, ...options, state: '.wrangler/state', settings: options.settings ?? ['.dev.vars', '.dev.vars.previous'] };
 // ownerBootstrap adds the generic displayName input to the installer model.
 // A declared custom name uses manifest validation instead; the lifecycle's
 // owner hook still performs the bootstrap with that input.
 const ownerName = result.input?.names?.name;
 if (typeof ownerName === 'string' && ownerName.trim() && ownerName !== 'displayName') result.ownerBootstrap = false;
 result.verbs = Object.fromEntries(Object.entries(verbs).filter(([verb]) => !['export', 'import'].includes(verb) || typeof result.portability?.[verb] === 'function').map(([verb, definition]) => [verb, { flags: [...definition.flags] }]));
 result.verbs.release = { flags: [...releaseFlags] };
 if (result.jobs !== undefined) {
  if (typeof result.jobs?.status !== 'function' || typeof result.jobs?.inspect !== 'function' || ['diagnostics', 'lifecycle'].some(name => result.jobs[name] !== undefined && typeof result.jobs[name] !== 'function')) throw new TypeError('jobs requires read-only status and inspect functions, with optional diagnostics and lifecycle.');
  result.verbs.jobs = { ...jobsVerb, flags: [...jobsVerb.flags] };
 }
 if (result.verbs.export && result.portability?.hostedExport !== undefined) result.verbs.export.effects = 'Export the local copy with --output, or run the declared hosted-export argv with --target remote. Hosted output keeps the seed\'s own format; the summary names its path and exit status.';
 return result;
}
