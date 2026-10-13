// Turn Base's dual-mode Markdown into package-only guidance for a converted
// seed. Keep the source docs useful to vendored and package adopters; the
// converter removes only the mode-specific instructions that no longer apply.
function replaceParagraph(text, marker, replacement) {
 const markerAt = text.indexOf(marker);
 if (markerAt < 0) return text;
 const start = text.lastIndexOf('\n', markerAt) + 1;
 const end = text.indexOf('\n\n', markerAt);
 return text.slice(0, start) + replacement + text.slice(end < 0 ? text.length : end);
}

function replaceListItem(text, marker, replacement) {
 const markerAt = text.indexOf(marker);
 if (markerAt < 0) return text;
 const start = text.lastIndexOf('\n', markerAt) + 1;
 const nextItem = text.indexOf('\n- ', markerAt);
 const nextHeading = text.indexOf('\n## ', markerAt);
 const ends = [nextItem, nextHeading].filter(index => index >= 0);
 const end = ends.length ? Math.min(...ends) : text.length;
 return text.slice(0, start) + replacement + text.slice(end);
}

function replaceNumberedItem(text, marker, replacement, nextNumber) {
 const markerAt = text.indexOf(marker);
 if (markerAt < 0) return text;
 const start = text.lastIndexOf('\n', markerAt) + 1;
 const nextItem = text.indexOf(`\n${nextNumber}. `, markerAt);
 const end = nextItem < 0 ? text.indexOf('\n\n', markerAt) : nextItem;
 return text.slice(0, start) + replacement + text.slice(end < 0 ? text.length : end);
}

export function rewritePackageMarkdown(path, source) {
 let text = source.replace(/\bnode scripts\/rer\.mjs\b/g, 'rer');
 text = text.replace(/(?:In vendored mode(?: only)?, )?`node scripts\/base-cli\/cli\/hosted-output\.mjs \. \[DECLARATION\]` runs the same check on an existing build\./g,
  '`rer verify` includes the hosted-output check.');
 text = text.replace(/(?:In vendored mode(?: only)?, )?`node scripts\/base-cli\/cli\/hydration\/check\.mjs[\s\S]*?counted in `--details`\./g,
  '`rer verify` includes the hydration check.');
 text = text.replace(/(?:From the runnable project\s+root|root), inspect the live queue with\s+`node scripts\/base-cli\/modules\/job-queue\/cli\.mjs status`\./g,
  'Package mode has no queue status command; a waiting command reports its live position.');

 if (path === 'RUN-LOCALLY.md') {
  text = replaceParagraph(text, 'First-party seeds pin the command implementation',
   'Package-mode seeds pin an exact `@runeditrun/rer` devDependency. The checkout\'s `OPERATIONS.json` argv and `package.json` aliases select the version that `rer VERB` runs.');
  text = replaceParagraph(text, '`rer` runs every verb with the checkout\'s own pinned copy:',
   'Package-mode seeds pin an exact `@runeditrun/rer` devDependency. The checkout\'s `OPERATIONS.json` argv and `package.json` aliases select the version that `rer VERB` runs.');
  text = replaceParagraph(text, 'Queue waits report immediately with a reason',
   'Queue waits report their reason and live position while the command waits. Package mode has no queue status command.');
 }

 if (path === 'HOMEPAGE-VARIANTS.md') {
  text = replaceParagraph(text, 'Base builds the mechanism once',
   'The shared homepage mechanism is described in `SEED-COMMAND-CONTRACT.md`. The deploy integration is exported as `@runeditrun/rer/deploy`.');
  text = replaceListItem(text, '- **Refresh shared behavior.**',
   '- **Refresh shared behavior.** Update the exact `@runeditrun/rer` pin with `pnpm add -D -E @runeditrun/rer@VERSION`. Copy `foundation/runtime/` from the Base commit you adopt into the seed\'s `src/base/` folder.');
  text = replaceListItem(text, '- **Refresh from Base**',
   '- **Refresh shared behavior.** Update the exact `@runeditrun/rer` pin with `pnpm add -D -E @runeditrun/rer@VERSION`. Copy `foundation/runtime/` from the Base commit you adopt into the seed\'s `src/base/` folder.');
 }

 if (path === 'AGENTS.md') {
  text = replaceParagraph(text, 'Queue waits report immediately with a reason',
   'Queue waits report their reason and live position while the command waits. Package mode has no queue status command.');
 }

 if (path === 'src/base/hydration/README.md' || path === 'foundation/runtime/hydration/README.md') {
  text = replaceNumberedItem(text, '3. Bring the shared check forward',
   '3. Update the exact `@runeditrun/rer` pin to a version that contains the shared check.', 4);
  text = replaceNumberedItem(text, '3. Refresh `scripts/base-cli/`',
   '3. Update the exact `@runeditrun/rer` pin to a version that contains the shared check.', 4);
  text = replaceNumberedItem(text, '10. Prove it:',
   '10. Prove it: `rer verify` passes with the check; `rer dev` shows one hydration warning per induced mismatch; and screenshots of each owner-reviewed public page at 1440 and 390 wide, animations settled, are pixel-identical before and after.', 11);
 }

 if (path === 'SEED-COMMAND-CONTRACT.md') {
  text = text.replace(/(?:Vendored seeds keep the token table and wiring note|The token table and wiring are) in `scripts\/base-onboarding\/README\.md`\./,
   'The package exposes its installer integration through `@runeditrun/rer/operator-installer`.');
  text = text.replace(/ \(vendored mode: `node scripts\/rer\.mjs deploy --site`\)/,
   '');
  text = text.replace('Run `rer verify` after refreshing `scripts/base-cli/` from Base in vendored mode, or after updating the exact `@runeditrun/rer` pin in package mode.',
   'Run `rer verify` after updating the exact `@runeditrun/rer` pin to a version that contains the check.');
  text = text.replace('Run `rer verify` after refreshing `scripts/base-cli/` from Base.',
   'Run `rer verify` after updating the exact `@runeditrun/rer` pin to a version that contains the check.');

  text = replaceParagraph(text, '`node scripts/export-cli.mjs --to-package SEED_ROOT` removes the old',
   'Package mode pins the shared command implementation as an exact `@runeditrun/rer` devDependency. `rer check --profile first-party` checks the installed pin; keep seed-owned application and onboarding journeys and run them against that pin.');
  text = replaceParagraph(text, 'Convert an unedited vendored seed with',
   'Package mode pins `@runeditrun/rer` exactly in `package.json` and `pnpm-lock.yaml`. After updating the pin, run `pnpm install --frozen-lockfile` and `rer check --profile first-party`.');
  text = replaceParagraph(text, 'Journey tests launch the installed package\'s `global/rer.mjs`',
   'Run package-mode checkout commands as `rer VERB`. Delivery operations and CI use `pnpm exec rer VERB` after the frozen install; heavy package scripts can use `rer queue NAME -- COMMAND`.');

  text = replaceParagraph(text, 'Documents name the production command, `rer VERB`.',
   'Package-mode documents name the production command, `rer VERB`. The seed pins `@runeditrun/rer` as an exact devDependency locked in `pnpm-lock.yaml` (SC-13); OPERATIONS argv and package aliases use `rer VERB`, and delivery operations and CI call `pnpm exec rer VERB` after installation. Adapters import declared exports including `@runeditrun/rer/adapter`, `@runeditrun/rer/local-installer`, `@runeditrun/rer/operator-installer` and `@runeditrun/rer/deploy`. Heavy package scripts use `rer queue NAME -- COMMAND`.');
  text = replaceParagraph(text, 'In vendored mode, ship a byte-exact pinned Base CLI export', '');
  text = replaceParagraph(text, 'Package scripts for `setup dev preview build verify reset deploy export import release outbox doctor describe check`',
   'Package scripts for `setup dev preview build verify reset deploy export import release outbox doctor describe check` use the package dispatcher: each value is the OPERATIONS argv (`["rer",VERB]`) joined by single spaces. Invoke them as `pnpm run VERB -- FLAGS`; use `pnpm run deploy`, not pnpm\'s built-in deploy. Never define a package `install` lifecycle script to launch `rer install`; `pnpm install --frozen-lockfile` is the dependency action. Provide `deps` (the same dispatcher with `install`) and `rer` (the dispatcher alone). Internal adapter targets use distinct names/files to prevent alias recursion.');

  text = text.replace(/Copies of Base's operator-auth layers[\s\S]*?`SC-05\.auth-copy\.\*`\)\./,
   'Copies of Base\'s operator-auth layers that the seed records (`base-copies.json`, `composition.lock.json` or `foundation.lock.json`) stay byte-exact to their pinned Base revision and share one application, runtime and schema pin (`SC-05.auth-copy.pin`). `rer check` names each drifted, missing or unrecorded file (`SC-05.auth-copy.*`).');

  text = text.replace(/In package mode there is no queue status verb;[\s\S]*?`node scripts\/base-cli\/modules\/job-queue\/cli\.mjs status`\./,
   'Package mode has no queue status command; a waiting command reports its live position.');
 }

 // A module path that is left names its copy inside the installed package.
 text = text.replace(/`scripts\/base-cli\/(modules\/[A-Za-z0-9_./-]+)`/g, '`node_modules/@runeditrun/rer/$1`');
 return text;
}
