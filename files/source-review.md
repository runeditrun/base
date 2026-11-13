# Fixture diagnostic source review

Base source reviewed: main d2a239a0b0d7b054b4f58b64f498f1c7aed8d22f.
Only cli/fixtures/dependency-link.mjs changes (11 additions, 3 deletions). Existing classification output, every assertion and the public command arguments stay intact.

- port_busy: cli/port.mjs busyPortMessage emits fixed prefixes for still unavailable, held by own checkout, or in use by a listener, including the saved-port variant. Classification discards the holder, path, PID, free-port suggestion and all other message text.
- port_unusable: cli/local.mjs availablePort emits Port N cannot be used on HOST for non-EADDRINUSE bind refusal. Only its fixed class is retained.
- listen_failed: cli/listen.mjs emits Could not listen on HOST for later non-EADDRINUSE failures. Only its fixed class is retained.
- private_input_custody: modules/demo/input-path.mjs containedInput emits the four retained validation prefixes. It can refuse absolute/traversal paths, symlinks, non-directory ancestors or a non-owned/non-private/non-regular file. Neither the input path nor its contents is emitted.
- dev_key_invalid: cli/dev-identity.mjs readDevKey emits the fixed malformed-key prefix. Key bytes stay private.
- portAnnounced: cli/lifecycle.mjs announces the port only after input/discovery and preflight availablePort. The diagnostic observes only event presence; it never includes the selected value or URL. A later refusal can therefore be distinguished from a refusal before announcement.
- appPortEqualsProviderEdge: the fixture releases its OS-selected app port before provider-edge server.listen(0), and the provider-edge listener remains alive until test teardown. Compare the selected app port with that listener's address at failure only. This retains a boolean, not either port number. A true value would establish the fixture's own edge occupies its selected app port; no such collision is asserted to have happened historically.

The fixed event/code allowlists, step-label recognition, exit-code bounds, provider-edge path/error allowlists are unchanged. Raw child messages remain excluded. No retry, port selection, threshold, safety check, runtime source, expectation or assertion changed.

Counts: zero permanent tests added/removed; cli/dependency-setup.test.mjs still generates five tests (two public link/browser journeys, two archive/relink journeys, one controlled-account deploy journey). Existing browser assertions run at 1440 and 390. No UI source changes. Clause status/count changes: none; no DONE claim.

composition/git-source.mjs testSource excludes fixtures; cli/export.mjs inventory applies testSource before composing exported runtime source. No delivered-source inventory, source lock or contract generation is affected by this fixture edit. Base root has no CONTRACT.md, ACCEPTANCE.md, edition.json or sources.lock.json to edit. Preserve the maintained reference inventories and all main work.

The immutable C failure (Verify 43467154033) was not polled, dispatched, rerun or altered. This diagnostic round does not establish a product fix or release acceptance.
