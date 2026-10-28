# Refreshing a vendored runtime namespace

Run the current installed CLI from the edition root:

```sh
rer refresh-base --ref FULL_BASE_COMMIT --base /absolute/base-checkout \
  --edition-migration run-data-paths --edition-migration run-data-pricing
```

When a newly delivered module imports a Base file already covered by a copy
mapping, refresh uses the most specific recorded origin subtree. For example,
`src/vendor/base/hydration` mapped to `foundation/runtime/hydration` covers
`unit.tsx`; no nested singleton record is needed. A new reference route can import
that existing vendor namespace instead of requiring `foundation` outside the
edition. Within equally specific directory mappings, an already recorded file
takes precedence over an omitted member. Existing resolvable edition imports
keep their destinations.

Refresh rewrites parsed dependency literals only. The result's `relocated` list
names the delivered files whose imports changed. These files become acknowledged
adaptations: their recorded digest and revision identify the original Base
source, and the acknowledgement identifies the relocated local bytes and mode.
`verify-base` checks both. Later refreshes preserve these seed-owned adaptations
and report upstream conflicts for explicit reconciliation. Review the result,
run `verify-base` and the edition's relevant checks, then lock source inputs last.

A genuinely unmapped dependency or equally specific competing mappings still
refuse before writes. Existing recorded source is never silently relocated.
Keep the directory record; `record-base` still refuses overlapping singleton
records rather than introducing conflicting provenance.
