# Sample target product contract

Sample helps a local studio publish a small catalogue and track its entries, replacing Paper Book and Card Box.

## Product target

| | |
| --- | --- |
| Category | Studio catalogue |
| Incumbents a buyer switches from | Paper Book, Card Box |
| Up-and-comers it must also beat | Small Ledger |
| First buyer | A US studio owner, USD, America Chicago |

The primary journey: publish the catalogue, create an entry, inspect it, then export the collection.

## How to read this contract

- This follows the RER contract standard.
- Core, Agent surface and Later describe the delivery tiers.
- DONE is proven through the product's doors.
- The Field proof register records outside proof.
- `ACCEPTANCE.md` and `docs/CLAIMS.md` are generated from this contract.

## Door rules

- **D-1.** Every write preserves the entry's owner.

## Shared duties (Base)

| Base duty | Duty | Delta clauses | Base journey |
| --- | --- | --- | --- |
| BASE-INPUT-001 | Validation | E1 | not run |
| BASE-AGENT-002 | Agent identity | SURFACE-001 | not run |

## Published clauses

- `PUBLISH-01`: *Tier:* Core

### Catalogue

#### PUBLISH-01 — Publish the catalogue

**Requirement.** A visitor reads the studio's published entries.

**Acceptance.** Through the public catalogue:
1. A published entry displays its title and owner.
2. A draft entry stays out of the public collection.

## Target clauses

### Entries

#### E1 — Maintain an entry

*Tier:* Core · *Cites:* BASE-INPUT-001 · *Rules:* D-1

**Requirement.** The studio owner changes an entry's description without losing its identity.

**Acceptance.** Through the entry editor:
1. Saving a changed description preserves the entry's identity and owner.
2. An invalid description leaves the saved description intact.
  The editor explains which field needs correction.

#### AUTH-HOST-01 — Archive a collection

*Tier:* Later · *Register:* R-1

**Requirement.** The studio owner archives a collection for a long retention period.

**Acceptance.**
1. An archived collection remains readable and refuses edits.

### Agent surface

**Specialist: Catalogue steward.** The steward maintains the studio's catalogue for a named person.

Inherits BASE-AGENT-001 to BASE-AGENT-013. The company's policy decides every call.

**How Sample computes each class.** Reading entries is standard; changing the owner is access.

| Tool | Does | Core clauses | Risk class | Today |
| --- | --- | --- | --- | --- |
| `sample.read` | Read an entry | PUBLISH-01 | standard | `sample_read` |
| `sample.edit` | Maintain an entry | E1 | standard or access | `sample_edit` |

**Resources.** Catalogue entries. **Events.** Entry changes. **Prompts.** Maintain a collection.
**Not tools, and why.** None.
**Limits.** A request reads at most one collection.
**Handoffs.** Entry changes emit a collection event.

#### SURFACE-001 — Maintain a catalogue through MCP

*Tier:* Agent surface · *Cites:* BASE-AGENT-002

**Requirement.** A named person's agent reads and maintains entries under the company's policy.

**Acceptance.** Through MCP:
1. Reading an entry reports the standard class and truthful attribution.
2. Changing its owner reports the access class and preserves the named person's role.
3. A seeded week completes under the held policy and under a company policy autonomous for every class.

## Field proof register

| ID | Proof | Clauses | State | Date | Receipt |
| --- | --- | --- | --- | --- | --- |
| R-1 | A retained collection remains readable after twelve months | AUTH-HOST-01 | not run | | |

## Boundaries

- Sample does not sell entries.

## Homepage claims

| # | Section | Claim | Clauses |
| --- | --- | --- | --- |
| 1 | Catalogue | Publish the studio's entries | PUBLISH-01 |
| 2 | Entries | Maintain and archive a collection | E1, AUTH-HOST-01 |

## Status

Judged from the code and tests at commit `abcdef0` (20 October 2026).

| Clauses | Done | Partial | Missing | Total |
| --- | ---: | ---: | ---: | ---: |
| Published | 1 | 0 | 0 | 1 |
| Target and push further | 0 | 2 | 1 | 3 |
| All | 1 | 2 | 1 | 4 |

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `PUBLISH-01` | Publish the catalogue | published | done | `README.md` | |
| `E1` | Maintain an entry | target | partial | `README.md` | Invalid descriptions still replace saved content. |
| `AUTH-HOST-01` | Archive a collection | target | missing | | Archive retention is absent. |
| `SURFACE-001` | Maintain a catalogue through MCP | target | partial | `README.md` | The seeded week is absent. |
