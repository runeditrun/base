// These check the removed vendored tree, including Base's own onboarding
// suite copied beside it. Package mode checks the installed pin with rer check;
// the package's internals are verified in Base, not in each adopting seed.
export const copyChecks = ['scripts/check-cli-copy.mjs', 'scripts/check-onboarding.mjs'];
export function withoutCopyChecks(command) {
 const parts = command.split(/\s*&&\s*/);
 const kept = parts.filter(part => !/^node\s+(?:\.\/)?scripts\/check-(?:cli-copy|onboarding)\.mjs\s*$/.test(part.trim()));
 return kept.length === parts.length ? command : kept.join(' && ');
}
