# Sample target product contract

Sample helps a local studio publish a small catalogue and track its entries.

## Product target

| | |
| --- | --- |
| Category | Studio catalogue |
| Incumbents a buyer switches from | Paper Book, Card Box |
| First buyer | A US studio owner using USD |

The primary journey: publish the catalogue, maintain entries, then archive the collection.

## Published clauses

### Catalogue

- **PUBLISH-01 — Publish the catalogue.** Visitors can read published entries.
  Draft entries stay private.

## Target clauses

### Entries

**E1 — Maintain an entry.** Owners can change an entry's description without changing its identity.

**Acceptance evidence:** The editor saves the description and keeps the entry's owner.

#### AUTH-HOST-01 — Archive a collection

Archive collections for a long retention period. Archived entries remain readable.

### Agent surface

#### SURFACE-001 — Maintain a catalogue through MCP

A named person's agent reads and maintains entries under the company's policy.

## Boundaries

- Sample does not sell entries.

## Homepage claims

| # | Claim | Clauses |
| --- | --- | --- |
| 1 | Publish the studio's entries | PUBLISH-01 |

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
| E1 | Maintain an entry | target | partial | `README.md` | Invalid descriptions still replace saved content. |
| `AUTH-HOST-01` | Archive a collection | target | missing | | Archive retention is absent. |
| `SURFACE-001` | Maintain a catalogue through MCP | target | partial | `README.md` | The seeded week is absent. |
