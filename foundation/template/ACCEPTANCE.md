<!-- Generated from CONTRACT.md by contract-docs. Edit CONTRACT.md, then regenerate. -->

# Accept a Technical foundation installation

The primary journey: Run the composed foundation, open its homepage, and inspect its health and unknown-route responses.

## Progress

| Tier | Done | Partial | Missing | Total |
| --- | ---: | ---: | ---: | ---: |
| Core | 1 | 0 | 0 | 1 |
| Agent surface | 0 | 0 | 0 | 0 |
| Later | 0 | 0 | 0 | 0 |
| Full target | 1 | 0 | 0 | 1 |

Judged from the code and tests at commit `BASE_COMMIT` (BASE_DATE). Field proof register: 0 rows; 0 passed, 0 failed, 0 not run.

## Core

### Foundation

#### HTTP-001 — Foundation routes

Core · published · **done**

**Requirement.** Hono serves `/health` and owns `/api` and `/api/*`; Start serves documents and its server-function transport. Unknown routes return 404. This is not product acceptance.

**Acceptance.** Through the emitted local Worker:
1. `/health` returns a successful health response.
2. The installed homepage returns 200 and shows the edition's name.
3. Unknown documents and unimplemented HTTP routes return 404, including `/missing`, `/health/extra`, `/api` and `/api/missing`.

**Evidence.** `tests/runtime.mjs`
**Gap.** None.

## Agent surface

None.

## Later

None.

## Field proof register

This technical foundation has no field proof requirements.
