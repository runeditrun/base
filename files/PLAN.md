# Browser prerequisite advice plan

Signed: Run Edit Run fleet, 2026-11-16.

1. Reproduce current doctor output through both the checkout dispatcher and installed-launcher dispatcher with synthetic pinned Playwright registries: neither executable, shell only, both. Capture the actual output without downloading or launching a browser.
2. Model the first-party default as headless Chromium use. Add an explicit adapter browser.headless=false declaration for headed use, exposed by describe and shared with doctor and provisioning. Preserve legacy Playwright pins that have no separate shell by selecting Chromium there.
3. Report only the executable needed by the declared use. Derive a browser-only command from the checkout-resolved Playwright CLI. Explain why it is needed, deferred acquisition on verify, and that rer install installs dependencies without browsers. Keep inspection read-only.
4. Provision only the required browser on first verify/run; retain pinned CLI, environment, cancellation, command capture and incomplete-install refusal. Use the same requirement for readiness and installation. Honor explicit headed package-run arguments.
5. Replace the browser prerequisite test with one focused public-door synthetic-registry journey covering default shell sufficiency, missing-shell repair, headed Chromium, both executables, legacy fallback, description and read-only behavior. Exercise provisioning through its exported module door with a recording command store, without browser downloads.
6. Refresh the maintained CLI export/inventory last; run focused touched tests, the reference typecheck and copy check. Commit only product/docs/copy changes. Reconcile current main before publication.
7. Run the complete full-history publication scan, inspect all candidate identities/trailers, push the named branch with the cloud guard, create a draft PR for native pull_request Verify and observe exact-head CI within the ten-call budget. Publish this packet separately to the evidence branch and report final product custody, counts and unchanged clause statuses.

No CONTRACT status, Gap or Evidence edits and no acceptance claims are requested. No UI screens change, so no browser screenshots apply.
