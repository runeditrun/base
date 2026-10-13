# Dependency patches

`miniflare@5.20260907.0-alpha.patch` — Miniflare's `SynchronousFetcher.fetch` (used by every synchronous
call on a Miniflare D1 or other proxy handle, such as `prepare` and `bind`) wakes from `Atomics.wait` on a
`notify` left over from the previous call when the calling thread was late to wait and the worker thread was
descheduled between its `store` and `notify`. It then reads no reply and fails `assert(message?.id === id)`
("false == true"), which showed up as a rare red `verify:modules` run. The patch keeps waiting until this call's
reply is queued. Drop it when Miniflare ships the same fix.
