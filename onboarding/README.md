# Shared local setup lifecycle

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

First-party seeds expose public operations through the RER dispatcher. From a
runnable seed checkout, the supported local sequence begins with
`rer install`, `rer setup` and
`rer dev`; owner sign-in uses the one-click `RER_OPEN` link. The
command contract and flags are documented in the runnable checkout's root
`RUN-LOCALLY.md`.

This directory contains the shared lifecycle and adapter helpers used by a
seed's RER setup and runtime commands. It centralizes manifest validation,
private settings, captured child commands, owner bootstrap, sign-in, local
state safety, readiness and cleanup. A seed declares its actual product inputs
and effects; the shared lifecycle does not create a product fallback or
provider behavior.

## Adapter contract

A first-party adapter in `scripts/installer/local.mjs` exports `commandAdapter`
and its setup hooks. The command adapter selects one root `rer-setup.json`
manifest and declares real targets and policy for dependencies, build,
migrations, development, preview, verification, deployment and portability.
Package scripts for public verbs run the vendored `scripts/rer.mjs` with the verb;
internal targets use different names so the CLI cannot call its own alias
recursively.

The shared setup lifecycle supports these hooks: `node`, `tools`, `prepare`,
`prepareData`, `dependencies`, `origin`, `secrets`, `build`, `migrate`, `start`, `health`,
`owner`, `signIn`, `hosting`, `guard`, `failure`, `features` and
`sessionSecretKey` (the setting that holds the application's session secret,
default `SESSION_SECRET`; a seed whose settings call it `AUTH_SECRET` declares
that). `prepareData` runs before `rer export` and `rer import`: declare it when those commands read
files the seed generates (a generated Worker config, for one) so a copy that never ran
setup or build still completes. It takes no input and must be safe to repeat. Setup also stops, before any request, when the process listening on the
expected port is not the one it started. A hook can
declare an argv command or use its provided context and command store. The
adapter owns real migrations, resource names, auth hooks, settings names, data
policy and deployment effects. The CLI owns parsing, public flags, pins,
containment, locking, capture, cancellation, output, exit mapping and
sequencing.

For `rer setup`, `dev` and `preview`, a custom `start` hook must bind its app
to `127.0.0.1:context.runtimePort`. rer's traffic proxy owns the port in
`context.origin`; use `context.origin` for public URLs and cookies, rather
than as the app's listening address.

A seed that declares `devIdentity` on its command adapter gets the key-gated way
in from the installer without declaring anything more: before setup the installer
creates the checkout's dev key (as `rer setup` does) and passes it to the hooks as
`context.devKey`. The `start` hook must give it to the temporary app (an
`RER_DEV_KEY` binding). When setup completes, the installer page offers the app
through the key exchange and dev owner entry (`RER_OPEN`); the key never enters saved state or logs. A seed
without `devIdentity` gets no key and its installer is unchanged.

`rer-setup.json` is the only setup schema. Its fields, groups, defaults,
conditional requirements and ordered steps define which answers are accepted.
Secrets are read privately from declared inputs, generated only where the
manifest specifies a generation method, and never accepted as CLI values.
`--owner-email` maps to the manifest's owner-claim field. A non-interactive
setup must supply every required answer; it never silently adopts the git
identity. Conflicting flag and answer-file values fail before effects.

## Seed theme

A seed dresses Base's installer and its shared sign-in and first-run frames in
its own look by declaring one theme: a plain CSS file at the root of the
directory its app serves as `/`, conventionally `public/rer-theme.css`. The file
holds only a `:root { }` block of `--rer-*` tokens and `@font-face` rules for
font files the app already serves; anything else is refused.

| Token | Value | Used for |
| --- | --- | --- |
| `--rer-page`, `--rer-surface` | `#rgb`/`#rrggbb` | page backdrop; cards and panels |
| `--rer-text`, `--rer-muted` | colour | body text; secondary text |
| `--rer-border` | colour | input and control boundaries |
| `--rer-focus` | colour | focus outlines |
| `--rer-accent`, `--rer-accent-text` | colour, declared together (optional) | primary buttons |
| `--rer-link` | colour (optional, defaults to text) | links and edit actions |
| `--rer-font-body`, `--rer-font-heading` | font stack (optional) | text; headings and product name |
| `--rer-radius` | `px` or `rem` length (optional) | cards, inputs, buttons |
| `--rer-logo` | `url("/path")` to an svg, png or webp the app serves (optional) | mark beside the product name |
| `--rer-done`, `--rer-partial`, `--rer-missing` | colour (optional; Base has defaults) | status fills on the run site's `/contract` |
| `--rer-done-ink`, `--rer-partial-ink`, `--rer-missing-ink` | colour (optional) | status words and counts on `/contract` |
| `--rer-on-done`, `--rer-on-partial`, `--rer-on-missing` | colour (optional) | labels printed on each status fill |

Contrast is checked against the declared colours before the installer starts:
text on page and surface, muted text on page and surface, links on surface and
accent text on accent need 4.5:1, as do each declared status ink on page and
surface and each `--rer-on-*` label on its declared fill; focus on page and
surface and borders on surface need 3:1. A failing pair is named with its ratio. Every `url()` must
name a same-origin file under the served directory.

The app must serve the file at `/rer-theme.css` with its fonts and logo; a
Worker that runs first and admits only listed static paths lists it too. If the
file cannot load, the frames fall back to readable neutrals.

Declare the theme in two places that name the same file:

- the installer seed descriptor (`scripts/installer/seed.mjs`) returns
  `theme: 'public/rer-theme.css'`, a root-relative path. The installer then
  links it, serves exactly the files it names, and loads its own token skin
  (`ui/theme.css`); the product name stays the descriptor's
  `branding.name`/`product`, and with no `--rer-accent` the buttons keep
  `branding.accent`.
- the Worker passes the served path to Base's frames: operator-auth
  `branding: { productName, theme: '/rer-theme.css' }` for sign-in confirmation,
  and `firstRunResponse(request, bindings, auth, { theme: { href:
  '/rer-theme.css', productName, accentColor? } })` from `src/base/setup` for
  `/setup`; the foundation sign-in uses `themeFrame` from
  `src/base/theme-frame` the same way.
  `accentColor` colours buttons when the theme declares no accent. A seed's own
  pages may read the same tokens by linking the file.

Without a theme every page is unchanged. `default-seed/public/rer-theme.css`
and the foundation template's `public/rer-theme.css` are worked examples.

### Select chevron

Every dropdown on Base's own screens draws its chevron 14px in from the right
border and keeps 40px of end padding so text never runs under it. One rule
does this, and a seed's own pages adopt it too:

```css
select:not([multiple],[size]:not([size="1"])){
  --rer-select-ink:var(--rer-muted,light-dark(#475569,#a8b3c4));
  appearance:none;
  background-image:
    linear-gradient(to top right,transparent calc(50% - 1.1px),var(--rer-select-ink) calc(50% - .55px),var(--rer-select-ink) calc(50% + .55px),transparent calc(50% + 1.1px)),
    linear-gradient(to top left,transparent calc(50% - 1.1px),var(--rer-select-ink) calc(50% - .55px),var(--rer-select-ink) calc(50% + .55px),transparent calc(50% + 1.1px));
  background-repeat:no-repeat;
  background-position:right 20px center,right 14px center;
  background-size:6px 6px;
  padding-inline-end:40px;
}
```

The two gradient strokes form one 12px chevron whose right edge is 14px from
the border. The full rule also carries the `:focus-visible`, `:disabled`,
right-to-left and `forced-colors` variants. Multi-selects and `size` lists keep
their native look.

- **Adopt it by copying.** Copy the whole rule from
  `foundation/runtime/select-style.ts` (exported as `selectStyle`, which both
  exporters place at `src/base/select-style.ts`). A seed whose pages use
  `pageStyle` already has it. A seed with its own stylesheet pastes the CSS
  into it, or imports `selectStyle` into a `<style>` tag. The installer's copy
  is in `ui/style.css`. A seed rule that sets `padding-right` on selects
  with higher specificity than the rule's `select:not(...)` (a `#id` selector,
  say) overrides the 40px end padding: keep it at 36px or more.
- **Recolour it with the theme.** The chevron reads `--rer-muted`, so a seed
  that declares its theme tokens needs nothing else: the installer, `/app` and
  every page using the rule draw it in that colour. A seed that wants another
  colour sets `--rer-select-ink` on `:root` (or one container); focus switches
  it to `--rer-text` and a disabled select dims it. For a dark scheme, declare
  `color-scheme: light dark` and dark values for `--rer-muted` and
  `--rer-text`; the neutral fallbacks use `light-dark()` and follow it. The
  chevron is drawn with gradients so it can read a variable; an SVG data URI
  cannot.
- **Keep the rule's geometry.** The browser checks (the installer's
  `ui/browser-check.mjs` and the default seed's private-response browser test)
  assert, at 1440 and 390, that every visible single select has no native
  appearance, at least 36px of right padding and its chevron 10-16px from the
  right edge.

`KEEP_BROWSER_CHECK=1` retains successful onboarding screenshots and axe reports;
failed checks retain them automatically.

The CLI wrapper's `RER_JOBS_MAX_WAIT_SECONDS` defaults to 1200 seconds, unlike the
bare queue's indefinite wait; admission timeout exits 75 without starting work.

## Setup behavior and custody

Setup validates answers before effects, then uses the declared lifecycle to
prepare local state, private settings, build and migrations, start the real
application briefly and prepare the first owner. It stops the temporary app before returning.
Reruns preserve an existing owner, data and exact settings bytes; setup does
not create a second owner or rotate secrets. Dev and preview use the saved
owner and canonical durable state. Dev opens through the local identity entry;
application mail is silently suppressed in development and demo.
Invited people choose **Sign in as <name>** in operator access or at `/signin`
to open `/app` with their assigned roles. A fresh local browser profile first
opens `RER_OPEN` to receive the checkout's key cookie. The local persona list
also accepts an invited or active person's email through `rer dev --as EMAIL`.

Adapters use the shared captured command store for child work. It redacts
registered credential values from terminal output and private logs, records
child outcomes, and stops owned descendants on failure or cancellation.
Readiness checks the application's real health endpoint and obeys cancellation
and deadlines. Builds temporarily remove declared private files from the build
environment and restore their exact bytes and permissions afterward. Do not
pass secrets in argv, print credentials, or substitute mocks for app behavior.

Canonical local durable data is `.wrangler/state`; CLI bookkeeping is
`.rer/local`; setup drafts and logs are under `.seed/installer`. Private
settings use mode 0600 and secret-bearing directories use mode 0700. State
selection rejects unsafe symlinks, traversal and overlap with source, exports,
dependencies or build outputs. Ambiguous existing state is preserved for
explicit recovery rather than adopted, moved or deleted silently. Reset uses
the adapter's declared removal inventory and preserves source, dependencies,
exports and deployment receipts.

Cleanup counts only live owned processes. Zombie or dead states (`Z`/`X`) have
already exited: they receive no signals, do not block parent escalation, and
cannot cause a remaining-process failure. Node reaps its direct children before
the command store finishes closing. Inspections have a three-second read bound;
an unreadable table is marked unchecked and grants no signalling authority.
Live children retain birth-identity checks and TERM-to-KILL escalation.
Group discovery precedes the final identity check for every TERM and KILL.
A same-birth zombie supervisor's erased title does not hide live descendants;
birth mismatches still reject cleanup. Unavailable owner metadata preserves
an existing operation lock, including a legacy lock without a birth stamp.
Missing boot or command metadata is unchecked, rather than evidence that a queue
supervisor has exited. After SIGKILL, queue cleanup observes live membership for
up to three seconds and retains the reservation if the group survives or cannot
be inspected. Failed resume inspections keep the approved unchecked diagnostic.


## Data, deployment and verification

To back up and restore this installation, use the local archive runner. This
is separate from bringing records in through the reviewed import door. Each
first-party adapter declares which resources that archive export/restore supports.
Every first-party seed verifies a complete local export/import/export round
trip across those resources. Archives are private and integrity-checked;
historical development mail, private settings and transient runtime state remain
excluded. Identity retention depends on the seed's archive policy: default-seed
excludes authentication identities and the owner claim, while foundation retains
selected identity tables and the original claim. A restored job remains bound to
its recorded principal; verify whether that principal survives the selected policy.
Archive restore validates and restores atomically into an empty destination.
Remote transfer is supported only when every required resource has a complete
adapter implementation; unsupported targets fail visibly.

Deployment uses each seed's actual owner-account declaration, resource policy,
migrations and health check. Application dry run builds and validates locally,
then uses Cloudflare credentials to read target secret bindings; it makes no
provider writes. Site and demo dry runs have their separately documented offline
behavior. Local tests and structural checks do not establish hosted
acceptance or external mail delivery.

Keep server authorization in every private handler, including direct server
function transports, and keep server-only code and secrets out of browser
bundles. Preserve applied migration history and use verified forward
migrations for schema changes. Keep files focused and choose shared source
placement for maintainability; a seed may adapt its stack and integration to
its real product requirements.
