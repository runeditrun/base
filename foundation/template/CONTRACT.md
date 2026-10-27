# Technical foundation target product contract

This is the technical foundation a new family starts from, not a product.
Replace this contract with the product's target contract, in the shape
`SEED-COMMAND-CONTRACT.md` describes under "Contract status", before building
product features.

## Product target

| | |
| --- | --- |
| Category | Technical foundation for a product not yet chosen |
| Incumbents a buyer switches from | None yet |
| Up-and-comers it must also beat | None yet |
| First buyer | None yet: the family author names one in the product's target contract |

The primary journey: Run the composed foundation, open its homepage, and inspect its health and unknown-route responses.

## How to read this contract

- This follows the RER contract standard; replace the technical scope with the agreed product target before building product features.
- Core covers the first buyer's first week and push-further work; Agent surface covers product jobs through MCP; Later preserves wider requirements.
- Done means every acceptance point is proven through the edition's own doors on the judged candidate; the Status table holds the evidence and gaps.
- The Field proof register holds proof the repository cannot produce; its rows never block done.
- `ACCEPTANCE.md`, `docs/CLAIMS.md` and the Status summary rows are generated from this file; edit this file, then regenerate.

## Shared duties (Base)

| Base duty | Duty | Delta clauses | Base journey |
| --- | --- | --- | --- |

This technical template makes no product-duty conformance claim. The product contract lists every applicable `BASELINE.md` duty, its delta clauses or `none`, and the conformance journey on the product's own data.

## Published clauses

- `HTTP-001`: *Tier:* Core

### Foundation

#### HTTP-001 — Foundation routes

**Requirement.** Hono serves `/health` and owns `/api` and `/api/*`; Start serves documents and its server-function transport. Unknown routes return 404. This is not product acceptance.

**Acceptance.** Through the emitted local Worker:
1. `/health` returns a successful health response.
2. The installed homepage returns 200 and shows the edition's name.
3. Unknown documents and unimplemented HTTP routes return 404, including `/missing`, `/health/extra`, `/api` and `/api/missing`.

## Target clauses

### Agent surface

**Specialist: not selected.** The product author defines the specialist when choosing the product's jobs.

The product contract inherits BASE-AGENT-001 to BASE-AGENT-013 and declares its deltas before offering agent access. The company's policy decides every call.

**How Technical foundation computes each class.** No product calls or risk class computations are defined yet.

**Tools.** No product tools exist in this technical foundation. The product contract maps every Core job to a tool or states a reason unrelated to risk, and declares how each tool's risk classes are computed.

| Tool | Does | Core clauses | Risk class | Today |
| --- | --- | --- | --- | --- |

**Resources.** None. **Events.** None. **Prompts.** None.
**Not tools, and why.** Foundation routing is an installation capability, not a product job.
**Limits.** No product capacity is declared. Business limits and spend caps belong to the company's policy.
**Handoffs.** None.

## Field proof register

This technical foundation has no field proof requirements.

## Boundaries

- This is a technical starting point, not a finished product or acceptance of a buyer's workflow.
- No product domain, incumbent replacement, import workflow or product agent surface is claimed yet.
- Preserve recorded owner requirements when replacing this template with the product contract.

## Homepage claims

| # | Claim | Clauses |
| --- | --- | --- |

No homepage claims are mapped yet; map the product's live homepage claims when choosing its target.

## Status

Judged from the code and tests at commit `BASE_COMMIT` (BASE_DATE).

| Clauses | Done | Partial | Missing | Total |
| --- | ---: | ---: | ---: | ---: |
| Published | 1 | 0 | 0 | 1 |
| Target and push further | 0 | 0 | 0 | 0 |
| All | 1 | 0 | 0 | 1 |

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `HTTP-001` | Foundation routes | published | done | `tests/runtime.mjs` |  |
