# Lamp and HappyToHelp regeneration

Local credential-free builds on 7 October 2026 used Node 26.8.1, frozen installs
and each seed's package-manager pin. Source revisions:

| Seed | Source line | Commit | Modules | Assets |
| --- | --- | --- | ---: | ---: |
| Lamp | main | cf4a9d4b76609db48ab9cb5f86303f198614b6d2 | 51 | 30 |
| HappyToHelp | release/0.2.x | f5f81ae0769bf579ad6e3355a10fdfbf454829d1 | 50 | 34 |

Each original producer ran against the built output. Base's producer then ran
twice, and its exported runtime ran inside the seed with no Base-checkout import.
Both runs and the exported runtime emitted byte-equal schema-2 manifests. Every
module and asset's raw payload equals the original base64-decoded bytes, and
every size and SHA-256 was independently recomputed. The complete deployment
specifications are structurally equal, including migration identity/order, SQL,
digests, bindings, public defaults, secret names, provider effects, surface
readiness and initial setup declarations. No provider call or deployment ran.

File-by-file justified differences from the hand-written producer outputs:

The emitted descriptor `sourceRepository` becomes the canonical URL `https://github.com/<owner>/<repo>`; the recorded example policies retain their accepted bare inputs.

| File(s) | Difference and reason |
| --- | --- |
| Lamp `lamp-worker-artifact.json` | Schema 1 inline base64 becomes schema 2 raw-payload descriptors with role, payload path, byte size and SHA-256. `rer-entry.js` remains the entry point and its exact source bytes are retained. Modules/assets use portable code-unit order instead of Lamp's host-dependent locale order. Deployment spec values and migration order are unchanged. |
| HappyToHelp `happytohelp-worker-artifact.json` | Same schema-2 transport change. `index.js` remains the entry point. Ordering, deployment spec and payload bytes are unchanged. |
| Each seed's `payload/modules/*` and `payload/assets/*` | New transport files contain exactly the corresponding original decoded bytes, including binary assets. Numeric names follow deterministic manifest order. Nothing is omitted or added to the deployable file set. |
| HappyToHelp `/fonts/inter/LICENSE.txt` and `/fonts/outfit/LICENSE.txt` descriptors | <code>application/octet-stream</code> becomes <code>text/plain</code>, the explicit MIME mapping for text files. Licence payload bytes are unchanged. No other MIME or module type changes. |
| Lamp `rer-project.json` | Canonical two-space JSON formatting replaces compact nested objects. The parsed descriptor is equal to the original. |
| HappyToHelp `rer-project.json` | Byte-equal to the original. |
| Lamp `.github/workflows/rer-managed.yml` | Quoted immutable workflow/artifact values, standardized verification description, and explicit `build_profile: edition` (the previous workflow default). Full/visual choices remain. The workflow SHA moves to the native-schema-2 delivery revision so raw payloads reach independent attestation. |
| HappyToHelp `.github/workflows/rer-managed.yml` | Quoted immutable workflow/artifact/profile values and standardized verification description. Full-only remains; project mode remains. The workflow SHA moves to the native-schema-2 delivery revision. |

The updated independent delivery attestation script was executed locally against
both complete Base-produced seed packages using test-only GitHub/OIDC responses.
It retained every manifest/payload byte and produced source-bound schema-2
receipts. This proves local workflow compatibility, not hosted OIDC/provider
acceptance. These seed policies and thin-caller rehearsals are part of the Base
kit; this task does not publish changes to the seeds or their release tags.

Native delivery workflow: `6d77ec14e366eb9f4acc0eac41fac40b61e2e10a`. Its full local suite passed 10/10;
no push-triggered CI is configured in that repository. The v1 tag remains deferred.

Full source commits and the private edition-authoring copy records retain the
comparison provenance. The Lamp packaging template uses `<owner>/<repository>`
for its source location; supply the edition's repository before packaging. The
comparison above describes the original configured run. Build outputs and source
clones are removed after verification.

The comparison above is historical evidence for its recorded revisions. The
current Lamp example declares `SETUP_TOKEN` and `SESSION_SECRET` in place of
`LAMP_BOOTSTRAP_SECRET`; the other required and optional secret names are kept.
This corrected packaging policy is not a new seed-build or provider comparison.
