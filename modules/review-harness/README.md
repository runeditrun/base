# Local browser review

This optional source module launches a synthetic loopback Worker, signs in through
a seed-provided oneclick URL or browser callback, checks Chromium pages and writes
private evidence. Product journeys, assertions about the signed-in UI, synthetic data and migrations stay in
the seed. It does not build, migrate, deploy or choose a product's routes for it.

Node 22 or newer and a POSIX host with `ps` are required for owned process groups.
The module has no package manifest or installed dependencies of its own. It uses
`createRequire` from the consumer's `package.json` and refuses different resolved
versions, including a different transitive axe-core:

| Consumer devDependency | Exact version |
| --- | --- |
| `@playwright/test` | `1.63.0` |
| `@axe-core/playwright` | `4.13.0` |
| axe-core brought by the axe adapter | `4.13.0` |

Move existing browser and axe devDependencies to these exact versions, update the
seed's own lockfile and install Chromium with `pnpm exec playwright install chromium`.
`PINS` and `resolveVersions(cwd)` expose the expected and actual versions. Only
Chromium is launched; no fallback browser or version range is selected.

## API

```js
import { startRuntime, journey, signIn } from './vendor/base/modules/review-harness/index.mjs';

const runtime = await startRuntime({
  cwd: process.cwd(), command: 'node',
  args: ['review-server.mjs', '--port', '{PORT}'],
  logDir: '.review-logs',
  fixtures: async origin => { /* Seed-owned synthetic data, after health. */ },
});
try {
  await journey({
    cwd: process.cwd(), origin: runtime.origin, evidence: '.review-evidence',
    async run({ page, capture, width }) {
      await page.goto('/signin');
      await capture('sign in');
      await signIn(page, {
        origin: runtime.origin,
        // Obtain a fresh oneclick URL from this seed's dev identity adapter.
        open: async (_page, signal) => createReviewSignInUrl(runtime.origin, signal),
      });
      // Assert the seed's signed-in UI here.
      await page.goto('/app');
      await capture('app', { canonical: true });
    },
  });
} finally { await runtime.stop(); }
```

`startRuntime({cwd,command,args,env?,healthPath?,readyTimeoutMs?,logDir?,secrets?,fixtures?,signal?})`
substitutes `{PORT}` with `0`. The seed-owned launcher binds its final listener
to port 0 on `127.0.0.1`, then prints `RER_READY http://127.0.0.1:<actual-port>`
as a complete stdout line after reading its listening address. The harness reads
that receipt and waits up to 120 seconds for a 200 health response (default
`/health`), including the time spent waiting for the receipt. It never probes and
releases a port for another process to bind. `{ORIGIN}` is no longer accepted in
arguments: the actual origin is available to `fixtures` after readiness. Pass explicit runtime bindings and synthetic
secrets; do not inherit production credentials. The child environment contains
only `PATH`, `HOME`, `CI`, a private `TMPDIR`, explicit `env` extras, and the three
enforced flags `WRANGLER_SEND_METRICS=false`, `CLOUDFLARE_INCLUDE_PROCESS_ENV=false`
and `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`. Logs redact registered values and
`token=` values, including chunked output. `stop()` is idempotent: TERM, a bounded
10-second wait, KILL if needed, and up to five seconds to confirm no live group member remains.
`stopTimeoutMs` adjusts the graceful wait. Start failure also cleans up the group.
Temporary storage is removed on stop; private logs remain for inspection.
An optional `AbortSignal` cancels health checks and fixtures and stops the owned
group. Fixtures receive `(origin, signal)` so seed-owned work can cooperate.
Readiness also probes the host's non-loopback IPv4 interfaces and refuses a
command that exposes the selected port there; the host must permit that check.

A Node HTTP launcher emits the receipt in its `listen` callback:

```js
server.listen(0, '127.0.0.1', () => {
  console.log(`RER_READY http://127.0.0.1:${server.address().port}`);
});
```

For Miniflare, set `host: '127.0.0.1', port: 0` and print the origin from
`await runtime.ready`. A Wrangler launcher must obtain the final address from
Wrangler's readiness output and emit the same receipt. Configure test-only origin
bindings after allocation without restarting ingress; a fixture can store its
explicit origin in test D1 configuration. If the Worker needs a stable logical
origin, its test transport can set an explicit `Host` header while workerd owns
an independent port-0 listener. Do not pass an address from a closed probe or
restart an ephemeral listener on its earlier port.

`signIn(page,{origin,open,timeoutMs?,signal?})` opens the seed's oneclick URL.
`open` can be a same-origin URL string or `URL`, or a callback `(page, signal)`
that returns one. A callback may instead complete the browser sign-in itself
and return nothing. The seed owns URL acquisition, identity selection and any UI
assertions; the harness does not request or store email. Supply fresh credentials
for every viewport when the seed uses single-use links.

Sign-in is bounded to 10 seconds by default. Cancellation or expiry aborts the
signal given to the callback; seed-owned work must cooperate with that signal.
A URL returned after cancellation or expiry is never opened. Browser navigation
uses the remaining deadline, while context cleanup belongs to the caller and is
handled by `journey`. Failure messages omit callback errors and browser call logs
because they may contain credential URLs. Keep oneclick credentials out of logs,
reports and captures; complete sign-in before capturing the application.

`journey({cwd,origin,evidence,widths?,secrets?,signal?,run,...captureDefaults})` launches one
browser and creates a fresh context per viewport, blocking service workers and
external requests before the first page opens. `run` receives
`{page,context,origin,width,viewport,capture,signal}`. Default viewports are 1440×900 and
390×844. Supply numbers to change widths or `{width,height}` objects to change
heights. Relative `page.goto` paths resolve against the loopback origin.
The browser and contexts close before return or throw. A `ReviewError` carries
the written `report` and `reportPath` when any gate or journey fails.
Cancellation interrupts pending journey work, closes its context and browser,
writes a failed report and skips remaining viewports.

`capture(page,name,{cwd,evidence,...options})` is also available directly. Install
`installCollection(context,{origin,secrets})` before navigation when managing your
own browser. Every capture settles network idle, fonts, two animation frames,
`aria-busy` and finite animations, then scrolls to the top and audits DOM,
accessibility, overflow, collected errors/network activity, rendered secrets and
Tab focus. Image retention never disables these checks. A failed capture throws
`CaptureError` with its recorded entry. `continueOnFailure:true` audits additional
routes after failures. `audit(page,name,{cwd,...options})` returns the same audit
and gates without creating any directory or image; custom drivers must handle its
`gate.passed` result and record it themselves.

## Image policy and proof history

Choose `capturePolicy` once per `journey` (or per direct-capture driver):

| Mode | Retained images | Use |
| --- | --- | --- |
| `canonical` (default) | States marked `canonical:true`, plus every failed capture | Ordinary review with selected owner proof |
| `failures` | Every failed capture | Routine checks where passing images add no evidence |
| `exhaustive` | Every capture | Approved visual acceptance requiring all states |

Mark the decisive views in the journey, for example
`capture('app', {canonical:true})`. Unmarked passing states are still audited and
listed in the manifest. A journey cannot override its run policy in a step.
One full-page image is retained per selected state by default. Ask for
`imageViews:['viewport']` for a viewport image, or explicitly request
`imageViews:['viewport','full-page']` when both prove a requirement. PNGs disable
animations. Canonical and exhaustive images preserve the settled view before
Tab moves focus, matching the previous capture behavior. Otherwise omitted
states create an image only after their audit fails; a keyboard failure's image
therefore shows the failed focus state. Duplicate width/slug pairs and colliding image names are rejected
before writing, including omitted images and repeated widths.

`journey({...,historyLimit:2})` keeps the current proof and at most two previous
owned proof folders by default. Use a nonnegative integer to change the bound;
zero retains only the current proof. Previous folders are adjacent to the current
folder, named `<evidence>.previous-<time>-<id>`. A small private ownership marker
binds each harness-created directory to its evidence path and filesystem identity.
Only matching real directories are rotated or pruned. Foreign folders, copied
markers and symlinks are preserved. An existing nonempty unowned evidence path is
rejected; choose a fresh child directory rather than adopting old proof folders.
An existing empty directory may receive evidence but is not claimed for deletion.
Concurrent writers to the same evidence path are rejected by a run lock, released
on return or throw. After a process crash, inspect a leftover lock before removing
it; the harness never guesses that another writer has stopped.

The CLI accepts `--capture-policy canonical|failures|exhaustive` and
`--history-limit N`, overriding `capturePolicy` and `historyLimit` in its config.
Routes accept `canonical:true` and `imageViews` just like journey captures. The
CLI prepares evidence before starting its runtime so logs and images rotate
as one owned proof folder. For programmatic journeys, keep runtime logs outside
the evidence path and manage their lifecycle in the caller; starting a runtime
inside a not-yet-owned proof path would create foreign evidence. Direct
capture/audit drivers own their history.

## Gates and report

The default axe tags are `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`.
Serious or critical violations fail; `failOn:'any'` rejects every violation.
More than one pixel of document or body overflow fails. Page errors, console
errors and hydration warnings, unexpected HTTP failures, external requests,
rendered `secrets` and failed keyboard focus fail. Browser resource-console
diagnostics are retained and attributed to their underlying request gate once.
External origins are aborted before dispatch; `data:` and `blob:` are permitted.
WebSocket routing is installed on the context before navigation. Same-origin
`ws:`/`wss:` connections use the corresponding HTTP origin and reach the real
server; foreign sockets are recorded and closed without connecting. Socket
attempts anywhere in the context, including seed-created pages, enter its next capture.
`expectStatus` sets the main document's expected status (200 by default); it never
excuses a failed subresource. A settle timeout also fails visibly.

Keyboard checks are on by default: during the audit, Tab must move focus off
the body onto `:focus-visible`. A document-only capture can set `keyboard:false`
only with a nonempty `keyboardReason`, recorded in its entry. Secret findings
record indexes, never values. Do not use real credentials in synthetic review;
a deliberately rendered synthetic secret can be visible in its defect screenshot.

`review.json` has schema version 2, the run's `capturePolicy` and `historyLimit`,
pinned/actual package versions, Chromium's version, origin, start/finish times,
`captures` (every audited state), run errors, totals and `passed`.
Each capture records its name, width, sanitized path, `canonical`, axe impact
counts and violation targets, overflow, collected errors and failed/external
requests, secret indexes, keyboard outcome, document status and gates.
`imageRetention` records `kept`, `reason` and `requestedViews`. Reasons are
`canonical`, `failure`, `exhaustive`, `noncanonical-state` or `passing-state`.
`images` lists only files actually written, with `file`, `view` and `bytes`;
omitted images have an empty array and an explicit reason. Image-writing failure
fails the capture, records `image-creation-failed` and retains any images already
written. There is no screenshot filename or hash for an omitted image. The old
schema's unconditional `screenshot` and SHA-256 fields are replaced by these
retention fields; consumers must read `images` before opening a file.
The report is written even when gates fail. Files are 0600 and directories are
0700. `writeReport` is exported for custom drivers using direct capture and
`onCapture`; `journey` handles it automatically.

## Maintained-path runtime

First run `pnpm build`. Apply every local migration to the same persistence
directory used by the Worker, with the seed's actual database name:

```sh
pnpm exec wrangler d1 migrations apply DB --config dist/server/wrangler.json --local --persist-to .wrangler/review
```

Start the Worker through a seed-owned launcher that binds port 0 on
`127.0.0.1` and emits the `RER_READY` receipt described above. In launcher
arguments use `{PORT}` for the allocation request. Configure local auth and
dev identity explicitly, including the seed's synthetic owner/session bindings.
When auth requires the browser origin, store the receipt's actual origin through
the seed's test configuration after allocation, without restarting ingress.
The harness intentionally disables
implicit `.env` binding loads. Fixtures run against the healthy Worker; they never
enter a product build. Build and migrations are preparation steps, not fixtures.

## Adopting

Copy exactly these files byte for byte into `vendor/base/modules/review-harness/`.
Do not copy the tests or fixture seed. The adoption test parses this fenced list:

<!-- adoption-files -->
```text
modules/review-harness/index.mjs
modules/review-harness/index.d.mts
modules/review-harness/versions.mjs
modules/review-harness/privacy.mjs
modules/review-harness/cancellation.mjs
modules/review-harness/files.mjs
modules/review-harness/process-group.mjs
modules/review-harness/process.mjs
modules/review-harness/runtime.mjs
modules/review-harness/collect.mjs
modules/review-harness/signin.mjs
modules/review-harness/settle.mjs
modules/review-harness/capture.mjs
modules/review-harness/audit.mjs
modules/review-harness/history.mjs
modules/review-harness/gates.mjs
modules/review-harness/report.mjs
modules/review-harness/journey.mjs
modules/review-harness/cli.mjs
```
<!-- /adoption-files -->

Pin the seed's devDependencies and add its review script:

```json
{
  "devDependencies": { "@playwright/test": "1.63.0", "@axe-core/playwright": "4.13.0" },
  "scripts": { "review": "node vendor/base/modules/review-harness/cli.mjs --config review.config.mjs --evidence .review-evidence" }
}
```

Create the seed-owned `review.config.mjs` (named exports also work):

```js
export default {
  start: {
    cwd: '.', command: 'node',
    args: ['review-server.mjs', '--port', '{PORT}'],
    // Add this seed's explicit synthetic bindings before running.
  },
  fixtures: async origin => { /* Seed-owned synthetic setup. */ },
  signIn: {
    // Import this seed-owned adapter in the config. Return a fresh oneclick URL.
    open: async (_page, signal) => createReviewSignInUrl(signal),
  },
  routes: [
    { name: 'sign in', path: '/signin' },
    { name: 'app', path: '/app', signedIn: true, canonical: true },
    { name: 'not found', path: '/not-found', expectStatus: 404 },
  ],
  secrets: [],
  widths: [{ width: 1440, height: 900 }, { width: 390, height: 844 }],
};
```

The CLI visits every route at every width and signs in once per width, immediately
before its first signed-in route. Keep public routes before signed-in routes if
their behavior depends on being signed out. It prints one summary with the report
path and exits zero only when all gates pass. Runtime launch/configuration errors
produce a failure summary; gate and journey failures also leave `review.json`.
SIGINT and SIGTERM cancel startup, fixtures, oneclick sign-in and journeys. The CLI awaits runtime
group cleanup and browser cleanup before exiting nonzero (130 or 143).
Its sign-in callback receives `(page, signal)` for
cooperative cancellation of seed-owned work.

Declare the component in `edition.json`, using the real Base repository and the
full immutable revision from which the files were copied. Use the clean, pinned
Base checkout that supplied the copy to obtain both values:

<!-- adoption-origin -->
```sh
BASE_REPOSITORY="$(git -C BASE_CHECKOUT remote get-url origin)"
PIN="$(git -C BASE_CHECKOUT rev-parse HEAD)"
```
<!-- /adoption-origin -->

Replace `BASE_CHECKOUT` with that checkout's path. In the component below replace
`BASE_REPOSITORY` and `PIN` with the resulting values; the repository must be the
actual source origin, and the revision must be its full immutable commit:

```json
{
  "id": "runeditrun/review-harness",
  "role": "module",
  "source": {
    "kind": "local",
    "paths": ["vendor/base/modules/review-harness"],
    "origin": { "repository": "BASE_REPOSITORY", "revision": "PIN", "paths": ["modules/review-harness"] }
  }
}
```

Before `lock`, `check`, `record-base` or `verify-base`, upgrade older seeds'
edition-authoring tool from the same pinned Base checkout. Copy all non-test
`.mjs` files and the whole `vendor/` directory (the vendored parsers and their
licences) from `edition-authoring/` byte for byte into
`scripts/edition-authoring/`, deleting retired tool files, and update the tool's
recorded source revision. See the [edition-authoring guide](../../edition-authoring/README.md)
for tool adoption and Base copy provenance. Upgrade the complete tool together;
copying only its CLI leaves required helpers missing.

Run this capability preflight from the seed before the provenance commands. It
checks the CLI's usage without reading a manifest, writing records or fetching
Base, and stops if either required command is unavailable:

<!-- adoption-preflight -->
```sh
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
const probe = spawnSync(process.execPath, ['scripts/edition-authoring/cli.mjs'], { encoding: 'utf8' });
const usage = (probe.stdout ?? '') + (probe.stderr ?? '');
if (probe.error || probe.status !== 1 || !/Usage:/.test(usage) ||
    !['record-base', 'verify-base'].every(command => usage.includes(command))) {
  console.error('Upgrade the complete edition-authoring tool before recording Base copies.');
  process.exit(1);
}
console.log('Edition-authoring supports record-base and verify-base.');
NODE
```
<!-- /adoption-preflight -->

Then run the seed's edition-authoring `lock` and `check`, and record and verify
the copy as described in the [onboarding guide's "Record the copy" section](../../onboarding/README.md#3-record-the-copy):

```sh
node scripts/edition-authoring/cli.mjs record-base vendor/base/modules/review-harness modules/review-harness PIN
node scripts/edition-authoring/cli.mjs verify-base
```

Add `verify-base` to the seed's verification. Each seed deletes its own launcher,
generic axe filter, overflow check and capture loop when replaced by this module.
Its product journeys stay. Adoption and its integrated proof are seed-owned work.

## Module verification

From Base run `TZ=UTC pnpm verify:review-harness`. The tests use real Chromium and
Miniflare with synthetic sessions, isolated defect pages, launcher process trees,
temporary consumer packages and a byte-for-byte vendor-folder adoption. The
declaration check uses the reference seed's installed TypeScript and browser types.
