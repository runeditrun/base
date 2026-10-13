# UI conventions

This guide sets the shared usability floor for seed UI work; implement its rules in the edition's chosen stack. The edition's own contract and baseline remain authoritative for its behavior, privacy, security, and operating promises. Use the [first-release acceptance guidance](FIRST-RELEASE-ACCEPTANCE.md) to record the minimum journey, unmet obligations, and evidence honestly. These conventions define a target; they do not claim that a shared UI kit, token schema, lint rule, or component already exists.

Rules in this guide are requirements. The final **Examples** section is illustrative: its labels, names, and states are not required product vocabulary or a prescribed data model.

## 1. Use business language

- Label pages, actions, and statuses with words the person doing the work understands. Prefer the business outcome over the underlying event, state machine, or implementation.
- Keep machine facts—record IDs (including ULIDs and UUIDs), versions, ISO-Z timestamps, dotted policy keys, hashes, and raw JSON—out of the ordinary work view. Preserve exact facts in a keyboard accessible disclosure labeled **Details**, attached to the relevant record. Do not discard useful audit or support information.
- Put a human summary in the main view and the exact machine facts in Details. A summary must not change the underlying fact or make an uncertain result sound certain.

## 2. Show caveats and outcomes truthfully

- State a caveat where it changes the decision or action, and only once in that decision path. Repeat it only when a later, separate decision depends on it. Do not use recurring banners for background limitations that do not affect the current choice.
- Keep decision relevant uncertainty visible beside the action. Put implementation detail and identifiers in Details.
- Distinguish estimates from measurements, local or test activity from live activity, and an attempted action from a confirmed outcome. Do not claim that work succeeded, reached a person, or was delivered without evidence of that result.

## 3. Open on work and keep navigation small

- After sign-in, open the person's current work or restore the protected page they requested before signing in. First-run guidance belongs alongside the first useful task; it is not a marketing landing page or a blank dashboard.
- On desktop, show no more than five direct primary destinations, followed by **More** when additional destinations are needed. On a mobile bottom bar, show no more than five items total, counting **More**.
- Name destinations by the work they contain. Keep the current location clear and let people return to the work list or requested item.
- Render unknown routes and page errors inside the application shell, with a clear route back to work or home. A 404 must be styled and usable, not a bare page or raw server error.

## 4. Make Send one action with an honest delivery chip

- Provide one clearly named **Send** action for the message or item being composed, with a nearby delivery chip for its latest known state. Do not present provider or channel details as competing send actions.
- Derive the chip from the actual delivery record. It must distinguish queued work, an in-progress attempt, provider acceptance, confirmed delivery, failure, and an uncertain result when those states exist. Offer retry or status-check actions only when the product can perform them safely.
- A provider accepting a request confirms only that handoff. It does not prove that the recipient received it. Use **Delivered** only when the product has evidence of recipient delivery; otherwise say what is known, such as **Accepted by provider** or **Status unknown**.
- Keep provider receipts and technical references available in Details. Never convert an unknown result into success to make the interface reassuring.

## 5. Make first use and empty states actionable

- Give a new user one concise first-run checklist for the product's real minimum journey. Each item states what remains and links to the real step that completes it. Show blockers plainly; do not mark an item complete without its completion evidence.
- Let a person dismiss the introduction without losing access to unfinished steps. Keep the checklist reachable from the product's help or setup area.
- When a list is empty, say whether it has no work yet or the current filters found none, and offer a useful action that the product actually supports. Do not fill empty views with fake records, invented counts, or decorative sample data.

## 6. Preserve focus, input, and drafts

- Dialog, Sheet, and Disclosure, including **Details**, all move focus into their content when opened, trap focus while open, return focus to the control that opened them when closed, and close on Escape. Move focus to the heading or first useful control; Tab and Shift+Tab cycle within the open surface.
- Make disclosures keyboard operable and expose whether they are open. The focus and Escape requirements apply to every disclosure, including ordinary inline disclosures.
- Closing a surface on Escape does not authorize discarding entered work. Retain the draft when closing; discard requires a separate explicit confirmation.
- Give every form field a visible label and associate inline errors with the field; set `aria-invalid` when invalid and never rely on color alone.
- Preserve unsent text when a person navigates within the app and returns. If a draft is not safely retained, warn before leaving and keep the text unless the person confirms discard. Do not say a draft is saved until it has actually been persisted.

## 7. Use shared semantic tokens and fully styled controls

- Use shared semantic roles for text, surfaces, borders, actions, danger, focus, spacing, and type. Provide neutral defaults and allow each edition to supply its own values. Token roles are a design convention; this document does not prescribe a token file or schema.
- Style controls explicitly so the interface remains usable under a global CSS reset or Tailwind preflight. Do not depend on browser default styles. Every button, link, input, select, and text area needs intentional base, focus, disabled, and relevant invalid or selected styles.
- Keep visible keyboard focus and communicate states with text or shape as well as color. A review should confirm that no control or in-shell 404 is left unstyled.

## 8. Capture ordinary work at both widths

- For UI review, use one realistic, consistently named synthetic business per edition and ordinary business content. Mark the data as synthetic in the capture caption, not in the product's customer-facing interface. Keep test IDs and fixture labels out of the screen.
- Capture the same ordinary end-to-end task from its useful starting point through its visible business outcome, including the signed-in work view. A setup-only frame or a form without its outcome does not show the journey.
- Save JPG captures at 1440 px and 390 px wide. Commit a `manifest.json` with the review evidence that pins the exact candidate commit and records the business, scenario, viewport, and path for each image. The screenshots show the interface at those sizes; they do not by themselves prove provider delivery or satisfy the product contract.

## 9. Load brand fonts once for every route

- Define font faces in one self-hosted stylesheet linked from the persistent root document head. Do not import font-face CSS from route or component modules: the temporary dev SSR stylesheet is removed during hydration. Keep the link present across navigation, including sign-in, setup, error and unknown routes. Native HTML documents that bypass the route renderer must use the same head declaration, including confirmation pages; preserve their private headers and restrictive CSP while permitting the same-origin font stylesheet and files.
- Preload the primary font file once in that same head with `as="font"`, its actual MIME type and `crossOrigin="anonymous"`. Its URL must match the stylesheet's URL exactly so the browser reuses the request. Load other weights or language subsets only when used.
- Provide a local fallback face with measured `size-adjust`, `ascent-override`, `descent-override` and `line-gap-override`. Place it immediately after the brand face in every applicable font stack, including identity pages and controls. Recalculate metrics when changing the brand font; matching metrics reduces layout movement rather than guaranteeing identical glyph widths.
- The foundation and reference demonstrate this in `public/fonts/fonts.css` and the root route. Font assets include their redistribution license. Production must carry this head pattern on every route; the dev proxy's cache policy alone does not establish production first-paint behavior.
- Refresh the seed's copied Base CLI to receive shared dev/preview font caching. Unhashed source fonts stay fresh for an hour; package and hashed URLs for a year. After editing a font during dev, use a browser hard reload to bypass its fresh cache and fetch the edited file. Ordinary non-font response policies remain the application's own.

## 10. Keep a hydration mismatch inside its section

- Page sections are hydration units: every outermost `header`, `nav`, `section`, `article`, `aside` and `footer` of a public page, and the root route's own chrome, sits in its own `HydrationUnit`, so a browser extension or proxy that edits one section before hydration rebuilds only that section. One-time entrance animations carry `data-intro` under the root's intro guard and never replay after a rebuild. Addresses, phone numbers, URLs and commands are the only child of their element. The convention and adoption steps are in Base's [hydration runtime README](../foundation/runtime/hydration/README.md) (in an edition, `src/base/hydration/README.md`); `rer verify` checks it.

## Examples

These examples illustrate the rules; adapt them to the product's own contract and vocabulary.

- Main view: **Order updated**. Details: event key, version, exact timestamp, and record ID.
- Delivery chip: **Accepted by provider** reports a provider handoff; **Delivered** requires recipient-delivery evidence.
- Empty state: **No requests yet** explains where requests appear and offers **Create request** only if that action is supported.
- Desktop navigation might use **Inbox**, **Customers**, **Reports**, **Settings**, and **More**. These are sample labels, not a required menu.
