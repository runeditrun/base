# Base delivery producer

One dependency-free producer packages a seed's emitted Wrangler configuration,
Worker modules, assets, exact SQL migration bytes and explicit source policy.
It emits a schema-2 delivery manifest and raw payloads, `rer-project.json`, and
`.github/workflows/rer-managed.yml`. These are untrusted candidate data; the
isolated delivery workflow validates payload identities and separately attests
source identity. Packaging does not deploy, tag, register a project or authorize
provider effects. Base adoption remains optional.

Use Node 22.20.0 or later. Build the seed first with its own pinned toolchain.
From Base:

```sh
node modules/delivery-producer/cli.mjs package \
  --root /absolute/path/to/seed --config rer-packaging.json --output rer-package
```

`--config` is a root-relative JSON file. `schema` is 1. `project` contains the
schema-1 project descriptor source fields; `managed` supplies a full immutable
`workflowRef`, matching `artifactFile`, explicit `buildProfile` and
`verificationProfiles`. Full verification is always the default. Project mode
supports only `['full']`; edition mode can declare `['full', 'visual']` and its
pinned `pnpmVersion`. `artifact` supplies `specInputs`, optional build-directory
paths, `mainModule` and explicitly named `additionalModules` (for example a
seed-owned entry wrapper). No product names or product detection exist in the
producer. Optional `edition` selects a component by `manifestFile` and
`componentId` from the real schemaVersion-1 edition authoring manifest; packaging
policy is separate from that manifest's authoring fields.

Optional `project.verifyWorkflow` is a nonempty workflow name or file path
(up to 300 characters), emitted as top-level `verifyWorkflow` in
`rer-project.json`. `rer release` reads it from the selected commit to choose
the GitHub verification workflow; `--verify-workflow NAME_OR_FILE` overrides it.
See `export/SEED-COMMAND-CONTRACT.md` for the full lookup order.

The producer writes descriptor `sourceRepository` as the canonical
`https://github.com/<owner>/<repo>` URL, with lowercase scheme and host and no
`.git` suffix or trailing slash. Input may use bare `<owner>/<repo>` or a GitHub HTTPS
URL with any scheme/host letter case and a terminal `.git`; owner/repository case
is preserved. Integration bundle `repository` remains an internal `<owner>/<repo>` key.
Literal repository names ending in `.git` are refused because the canonical URL
cannot represent them without changing identity; the release gate still reads a
URL such as `https://github.com/<owner>/<repo>.git.git` as `<owner>/<repo>.git`.

Use `setup: {manifestFile: "rer-setup.json"}` to select the seed's committed root
file, shared with its installer. Optional `setup:{manifestFile}` selects a root-relative Base setup manifest.
Base validates its exact UTF-8 source bytes against `schema/SETUP.schema.json`
and the cross-field rules before packaging; a valid selection emits deterministic
`rer-setup.json` beside `rer-project.json` and adds its exact-byte SHA-256 to
the project descriptor. A selected root `rer-setup.json` must already be in
canonical form: `JSON.stringify(manifest, null, 2)` plus one newline. Packaging
refuses other formatting and preserves the committed bytes; the emitted file
and its digest are exactly those the installer reads. Any other selection keeps
canonical emission for projects with their own tooling. Without `setup`, the prior descriptor and package
outputs remain unchanged. The artifact-only command validates the selection as
well, so later build callers cannot skip schema checks. Exported runtimes carry
the setup schema and both validators they need.

Public setup fields and groups may declare `audience: "owner" | "developer"`.
Fields inherit their group's audience, defaulting to `"owner"`; an explicit
owner field in a developer group is invalid. Unknown audiences and audience on
secrets are refused. This lets owner-facing consumers omit developer settings;
Base's local installer and `rer setup` continue to show all active public fields.
See [the setup contract](../../schema/SETUP.md) for inheritance and value rules.

`artifact.specInputs` declares allowed public variable names, required/optional
secret **names**, migration prefixes and additional migration directories,
health/recovery policy, provider effects, surfaces and initial setup probes.
It never supplies secret values.
Optional `surfaces.app.signIn: {path: "/login", loginHint: true}` declares the
browser sign-in path. `loginHint` is a required boolean; declare `true` only if
the app reads `login_hint`. The path starts with one slash and contains only
ASCII letters, digits, slashes, underscores and hyphens. Only the app surface
may declare sign-in. `signIn` may also carry an optional `ownerSignIn` path, the
route that accepts the platform's owner sign-in grant (for example
`/auth/owner-signin`), with the same path rules. Without an explicit sign-in policy, a seed's
`OPERATIONS.json` `seedContract.adapter` supplies its `commandAdapter.signInPath`
with `loginHint: false`; without either declaration the field stays absent.

Optional `nativeExport: {path: "/export", covers: ["DB", "CHAT_HUB"]}` declares
the app's native export. These are its only keys. The path is at most 256
characters, starts with one slash, uses letters, digits, `.`, `_`, `~`, `-`
and single separating slashes, and has no `.` or `..` segments. `covers` names
1–64 distinct declared bindings: D1 databases whose migration statements create
virtual tables, or Durable Objects. Comments, strings and trigger bodies do not
establish virtual-table coverage. Other bindings are refused. The declaration
is absent unless supplied; it does not change `recovery`.

Each surface's `originVariable` must be unique across surfaces; validation names
the variable and conflicting surfaces when it is repeated. `rer check` and
ordinary `rer deploy` (including `--dry-run`) check declarations in
`rer-packaging.json`, `packaging.json`, `scripts/delivery/base/packaging.json`
and `management/integration/deployment-spec.json` before starting work.
Build-emitted Wrangler JSON provides resource
bindings, compatibility settings, native Durable Object migrations, schedules,
queue consumers and public defaults. Resource account IDs/names are omitted.
Unsupported native binding/options, unknown policy fields, duplicate JSON keys,
symlinks, private paths, invalid migration identities/digests and oversized inputs fail.
KV, Analytics Engine and Durable Object storage have explicit incomplete
portability via `capabilities.mjs`; packaging support does not claim export or
restore support.

## Managed mail

Managed mail opts in through `artifact.specInputs.mail: {providers: ["rer"]}`.
Declare `MAIL_PROVIDER`, `MAIL_FROM` and `MAIL_RELAY_URL` in
`publicVariableNames` and the emitted Wrangler `vars` (empty strings are valid
unconfigured defaults), and `MAIL_API_KEY` in either `secretNames` or
`optionalSecretNames`. The producer preserves the mail declaration in the
candidate deployment spec and rejects missing or incorrectly classified bindings.
RER assigns the provider, sender and relay URL and provisions the private
installation credential when Managed configuration is saved. No SendGrid key
belongs in the app's configuration or build.

To author the matching committed setup manifest, compose the exported
`generateMailSetupFields({providers: ["rer"]})` from `mail.mjs` into its
`fields`. It supplies the public provider selection, sender and relay URL and
an entered secret key, required when `rer` is selected. Add `resend`, `sendgrid`
or `cloudflare` to retain direct provider choices; the helper adds Cloudflare's
account input when selected. These generated fields use the existing setup
schema and conditional presentations. Packaging, artifact generation and runtime
export validate any selected manifest against the managed mail declaration.
Existing manifests can declare equivalent fields themselves. Unselected setup
manifests and projects without a mail declaration keep their existing behavior.
Managed Configure hides these inputs and supplies them itself; Assisted hosting
uses the ordinary selected provider inputs. The adapter sends through
`${MAIL_RELAY_URL}` with the private `MAIL_API_KEY`, following the managed mail
relay contract; no sender or installation ID is sent in its JSON body.

The output directory must be fresh and empty. Its layout is:

```text
rer-package/rer-project.json
rer-package/rer-setup.json                   # only when setup.manifestFile is selected
rer-package/.github/workflows/rer-managed.yml
rer-package/delivery-artifact/<artifactFile>
rer-package/delivery-artifact/payload/modules/000000...
rer-package/delivery-artifact/payload/assets/000000...
```

For edition-owned source, vendor this same runtime once:

```sh
node modules/delivery-producer/cli.mjs export \
  --root /absolute/path/to/seed --config rer-packaging.json
```

This writes `scripts/delivery/base/` with the Base runtime and `packaging.json`.
Replace the hand-written `scripts/build-delivery-artifact.mjs` implementation
with the following thin caller (remove the superseded spec/collection modules
once their consumers have migrated):

```js
import {readFile} from 'node:fs/promises';
import {produceSeedArtifact} from './delivery/base/package.mjs';
const config = JSON.parse(await readFile(new URL('./delivery/base/packaging.json', import.meta.url)));
console.log(await produceSeedArtifact({config}));
```

Or use the exported CLI directly:
`node scripts/delivery/base/cli.mjs artifact --config scripts/delivery/base/packaging.json`.
The `package` command emits all three outputs; `artifact` emits only the delivery
package on later builds. Commit the generated descriptor/workflow to the seed
through its release process. Local artifact-inspection tests must read schema-2
payload files and verify their size/hash; inline `contentBase64` is schema 1 only.
Do not delete their existing runtime assertions.

`examples/lamp.json` and `examples/happytohelp.json` are explicit policies taken
from the recorded source revisions in [COMPARISONS.md](COMPARISONS.md), not
special cases. Review them when seed policy or the trusted workflow changes.
The pinned delivery workflow must support native schema-2 payload upload and
attestation before adopting these callers. No delivery v1 tag is created here.

Run `pnpm verify:delivery-producer`. It is included in `pnpm verify`.

Repository syntax fixtures use host templates expanded by their test consumers.
The shared producer and publisher cases retain their exact URL spelling, case,
length and rejection checks without declaring synthetic GitHub repositories.

## Native AI

A delivery package has no approved native AI route. An `ai` field in
`artifact.specInputs`, in the deployment-spec options or in a candidate
specification is refused with `ai_hosting_unproven` before anything is packaged,
exported or passed by `rer check`. A raw Wrangler `ai` binding stays an
unsupported binding, and no name a package declares may use the reserved
`RER_AI_` namespace (`ai_policy_conflict`). Native AI is served only by
`rer deploy` to the owner's own Cloudflare account; see the
[consumer guide](../ai/native/README.md).
