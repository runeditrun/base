# Technical foundation acceptance

`pnpm typecheck` and the typecheck stage of `pnpm verify` use checkout-local, gitignored `.cache/typecheck.tsbuildinfo`; deleting it forces a full check, while `pnpm build` still builds the real Worker and assets.

This is a runnable starting point for authoring, not a finished useful edition.
HTTP-001 in CONTRACT.md covers Hono health/API ownership and Start documents.
`pnpm run verify` builds, typechecks, then tests the emitted Worker locally: health,
SSR document and both HTTP/document 404s. `pnpm run setup -- --owner-email EMAIL`
builds, migrates D1, prepares the real owner and stops its temporary local app.
The shared command journey also tests automatic owner sign-in, the authenticated
page, HMR and reset. These results establish the local technical slice when run
successfully. No hosted health, product owner workflow,
accessibility audit or product release acceptance is claimed.

Choose an owner workflow and its useful first-release floor before adding product
functionality. Preserve wider requirements separately and require native-session
and direct private-server-function tests before introducing private data. Record
actual evidence and remaining gaps here as the edition develops.
