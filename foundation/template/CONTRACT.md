# Technical foundation

This is the technical foundation a new family starts from, not a product.
Replace this contract with the product's target contract, in the shape
`SEED-COMMAND-CONTRACT.md` describes under "Contract status", before building
product features.

## Product target

| | |
| --- | --- |
| Category | Technical foundation for a product not yet chosen |
| Incumbents a buyer switches from | None yet |
| First buyer | None yet: the family author names one in the product's target contract |

## Foundation

- **HTTP-001 — Foundation routes.** Hono serves `/health` and owns `/api` and `/api/*`; Start serves documents and its server-function transport. Unknown routes return 404. This is not product acceptance.

## Status

Judged from the code and tests at commit `BASE_COMMIT` (BASE_DATE).

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `HTTP-001` | Foundation routes | published | done | `tests/runtime.mjs` |  |
