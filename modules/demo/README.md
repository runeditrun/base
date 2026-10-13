# Demo mode

`withDemo(worker, { seed })` makes a seed safe to show: with `RER_DEMO=1` in the
runtime (`rer demo`, or a hosted demo) nothing is sent, the seed's demo data is
in place, and every page says so. Without `RER_DEMO` it returns the worker
unchanged, so the deployed app is exactly as before (`rer deploy` refuses a
declaration or deploy settings that carry `RER_DEMO`).

With `RER_DEMO=1`:

- **Nothing leaves.** When the module is evaluated it replaces global `fetch`
  for the whole isolate (routes, cron, queue consumers, Durable Objects). A
  loopback host is allowed; anything else throws `TypeError: fetch failed`, the
  error a failed delivery already raises. Each refused call is recorded, method
  and host only, in `rer_demo_outbound`.
- **Demo data once.** After the owner exists, `seed(env, { ownerEmail, now })`
  runs once (marked in `rer_demo`). It must be idempotent.
- **A visible bar.** Every HTML page opens with "Demo · nothing is sent · ends
  HH:MM", the captured mail (development outbox subject and recipient) and the
  blocked sends. Its style is allowed in the page's CSP by hash.
- Mail stays in the development outbox and AI stays unconfigured: demo settings
  never carry provider keys.

Both tables are created by the guard at runtime, never by a migration, so they
exist only in a demo's own throwaway database. Adopting it is three changes in a
seed; see `export/DEMO.md`.
