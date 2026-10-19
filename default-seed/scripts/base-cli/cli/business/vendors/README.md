# Shipped vendor exports

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

`exportVendor(vendor, {key, inputs, checkpoint, signal})` is an async generator.
It yields `{name, bytes: Buffer, checkpoint}`. Keys remain in memory and are
attached only to GET requests on the adapter's fixed HTTPS origin. Redirects,
caller origins, arbitrary paths and credential-bearing pagination are refused.
No export runs merely by importing these modules. No account export was run
during implementation.

`VENDORS` is the closed vendor enum. `VENDOR_CAPABILITIES` describes the adapter,
required vendor-key capability, native importer format, layout and read scopes.
These adapters cannot verify that a supplied key itself has read-only scope;
the owner must create the documented read-only key where the vendor offers one.

## Transport and resume

Upload bytes only to the task grant's seed destination. They contain private,
untrusted vendor data and must never appear in CLI output, events or model
context. The caller applies its outbound secret detector and computes SHA-256,
enforces the grant quota, and atomically acknowledges the item before persisting
its checkpoint. Checkpoints contain progress, source IDs, cursor strings, file
metadata and hashes, never response records. They are less than 128 KiB.

An interrupted upload is retried under the same task/fence, deterministic name
and SHA-256. Resume with exactly the acknowledged checkpoint and original
inputs; object key ordering does not affect input identity. An unacknowledged
page may be fetched again, so source edits during interruption can change it:
the seed must reject a conflicting hash under the same name, and the owner must
restart that export. This is an API export, not a vendor snapshot transaction.

For `layout: 'concatenate'`, concatenate the numbered `000001.part` items in
sequence to the metadata's `output` filename. Some PagerDuty items have empty
bytes: they checkpoint schedule discovery and must still be acknowledged.
Fragments are deliberately not standalone JSON. For `layout: 'files'`, retain
the given filenames; Calendly ends with `manifest.json`, matching Dial's folder
import. Never treat a partial stream as a completed bundle.

Every item is at most 1 MiB. Exports are bounded to 1,000 requests, one request
per second, 30 seconds per request, 2 MiB/499 API records for Sentry,
512 KiB/500 records for PagerDuty, and 8 MiB/2,500 records for UptimeRobot and
Calendly. The output bound includes JSON framing and Calendly's manifest.
Limits stop rather than truncate. AbortSignal stops waits, HTTP reads and
emission. HTTP errors contain only a fixed code and numeric status; network,
parsing and unexpected errors never expose response text, URLs or key values.
429 stops with `RATE_LIMITED`; there is no hidden retry loop.

## Credentials in responses

Every adapter strips credential values from a parsed response before it emits
bytes for upload, keeping the record, by the same rules as the seed's import
door. A field whose name's letters end in a credential word (`apiKey`,
`httpPassword`, `http_password`, `client_secret`, `X-Api-Key`, `integration_key`,
`webhook_url`, `secret_key`, `x-functions-key`, `Ocp-Apim-Subscription-Key`,
`pwd` and the like) or are `X-Auth`, the `value` of a `{name|key, value}` pair
naming one (`{name: 'Authorization', value}`), or the value of such a
`[name, value]` pair in a list of them (Sentry's header tuples), becomes
`"[removed]"`. A plural name (`apiKeys`, `tokens`) counts only when it holds
text, so a count such as `tokens: 1500` stays. A URL of any scheme keeps a
marker where each credential was: its user name and password become `removed@`,
and the value of each credential query or fragment parameter (`api_key`,
`access_token`, `sig` and the like) becomes `removed`
(`?api_key=removed&region=eu`, `#access_token=removed`), except the adapter's
own validated pagination keys (`page_token`). The door drops each marker and
reports it per record as `CREDENTIAL_REMOVED`, so the owner sees which record
lost a credential. Null, booleans, empty strings and masks such as `****` are
not credentials and stay as they are. Names that merely contain such letters
(`keyword`, `monkey`, `signal`, `design`) are not credential names.
Pagination is read from the response as received, so a credential-bearing
pagination link is still refused.

## Inputs and native coverage

* `sentry`: `organization: {id, slug, region: 'us'|'de'}`, `start`, `end`, and
  optional `events: [{project, eventId}]`. Self-hosted origins are unsupported.
  Projects, releases and all-status issues are paginated; issues use the current
  organization issues API filtered by project and window. Event details are
  fetched only for the explicitly selected IDs, must fall in the window and
  form a complete local cursor chain. A fixed omissions list declares that all
  other event history and unsupported Sentry features remain outside the export.
  Projects/releases are not time-filtered. Spool counts one manifest record in
  addition to the API records. At most 49 projects fit its 100-collection bound.
* `uptimerobot`: no additional inputs. Exports v3 monitor response pages,
  including their original `data` and `nextLink` envelopes. History, contacts
  and status pages are not fetched.
* `pagerduty`: `start`/`end` (or `since`/`until`). Exports users, schedule details
  with layers/final coverage, overrides for the window and escalation policies.
  Schedule listing only discovers IDs and is not duplicated in the bundle.
  Overrides retain full boundaries with `overflow=true` and add `schedule_id`,
  as Oncall's documented bundle requires. Incident history and paging
  configuration are not fetched.
* `calendly`: optional `asOf` timestamp (recommended for a repeatable catch-up).
  An omitted timestamp is captured at first invocation and retained on resume.
  Downloads the current user, event types, availability schedules, per-type
  availability, future scheduled events including cancellations, and invitees.
  Like Dial's downloader, this is the current user's scope, at most 100 event
  types and 500 scheduled events. Every original page receives a manifest hash.
  No past booking history or arbitrary referenced resource is fetched.

## Primary-source provenance

Implementation preserves the response formats and flow in these seed sources;
it adds streaming, bounded resume and fixed-origin transport rather than running
their file-writing command wrappers.

* [Dial downloader at 6014c99875dd002545e194ab23a7852d30e94e01](https://github.com/just-every/run-dial/blob/6014c99875dd002545e194ab23a7852d30e94e01/scripts/move-in/download.mjs).
* [Uptime guide at 157686b52ecc652d64250a30ec224f1a47355a6c](https://github.com/just-every/run-uptime/blob/157686b52ecc652d64250a30ec224f1a47355a6c/docs/moving-from-uptimerobot.md).
* [Oncall guide at 4f928effc3ce735f3d246bb8a3c4bbb8436cae6b](https://github.com/just-every/run-oncall/blob/4f928effc3ce735f3d246bb8a3c4bbb8436cae6b/docs/move-in.md).
* Spool's proposal-cited `app/docs/SENTRY-SWITCHING.md` and
  `app/src/domain/sentry-import/source.ts`, local source commit
  `39cbaf67de3bc8174bf941a6922bb92ff31110de`. Spool supplied a bundle contract,
  not an existing downloader. This adapter implements that contract against
  the official APIs below.
* Sentry: [projects](https://docs.sentry.io/api/organizations/list-an-organizations-projects/),
  [releases](https://docs.sentry.io/api/releases/list-an-organizations-releases/),
  [organization issues](https://docs.sentry.io/api/events/list-an-organizations-issues/),
  [event details](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/),
  [pagination](https://docs.sentry.io/api/pagination/),
  [regional domains](https://docs.sentry.io/api/).
* [PagerDuty overrides](https://docs.pagerduty.com/developer/api/reference/rest/schedules/list-schedule-overrides)
  is a window-bounded response, not an offset-paginated list.

Seed documentation and official APIs were inspected on 16 October 2026.
These sources document shapes; no real-account parity or migration success is
claimed. Parent integration must provide seed assembly and transport under the
actual import grant protocol, plus network-edge acceptance coverage.
