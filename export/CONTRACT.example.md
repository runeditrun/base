# CONTRACT.md — Support Inbox edition

This example defines intended behaviour. Every released clause requires a stable ID and tagged test; verification must distinguish satisfied, overridden, broken and uncovered guarantees. The example itself provides no implemented coverage. Security, privacy, and operational guarantees are in `BASELINE.md`; a clause here may supersede one of them by naming its `BASE-` ID (none does). Capacity and rate limits are in `seed.json → limits`. Times are p95 at those limits. Clauses marked *Policy* have a default that owners may replace through the named extension point or coherent source changes.

This edition contract accompanies the complete editable product. It is not a mandatory family feature set. Its finished inbox UI combines shared conversation domain with selected email, widget, AI and other capabilities. A family contract covers its selected shared domain; modules carry their capability guarantees; the edition makes the selected composition and end-to-end behaviour testable. Keep applicable clause IDs traceable without duplicating or weakening their meaning. All layers are MIT. This document illustrates contract quality, not implemented coverage or new manifest fields.

## Scope

A support inbox for one business. Conversations arrive by email and from an embeddable chat widget; operators reply from one inbox; AI drafts, triages, translates, and, when enabled, replies on its own within rules the operators set.

## Operators

- **OPS-001 — Equal operators.** Every operator can see and act on every conversation except where a policy restricts an action. There are no roles.
- **OPS-002 — Management.** Operators are invited and removed in settings. The operator configured at setup can be removed only by themselves. *Policy: `operator.management.v1`; default: any operator may invite or remove.*

## Channels

- **CHAN-001 — Inbound email.** A message sent to the configured support address becomes a conversation within 60 seconds, capturing subject, text and HTML body, sender, and attachments.
- **CHAN-002 — Threading.** A customer reply lands in the originating conversation, matched by threading headers, then by normalised sender and subject against that sender's most recent open conversation. Anything unmatched starts a new conversation.
- **CHAN-003 — Outbound email.** An operator reply to an email conversation is sent from the support address within 60 seconds with threading headers that return the customer's reply to the same conversation. Attachments travel as email attachments within the provider limit.
- **CHAN-004 — Widget inbound.** A visitor message appends to the visitor's open conversation or starts one; a visitor has at most one open conversation. It appears in the inbox within 2 seconds.
- **CHAN-005 — Widget outbound.** An operator reply reaches a connected visitor within 2 seconds. A disconnected visitor sees it on reconnect and, if they have given an email, receives it by email.
- **CHAN-006 — Attachment delivery.** Attachments are readable by the visitor session that owns the conversation and travel as email attachments to email customers.
- **CHAN-007 — Delivery failure.** A failed send, including an asynchronous bounce, is retried up to 5 times over 1 hour before being marked failed on the message.
- **CHAN-008 — Automatic mail.** Messages with auto-submitted or bulk headers, and replies from no-reply addresses, are attached to the conversation but do not reopen it, notify anyone, or trigger AI.

## Widget

- **WIDGET-001 — Embed.** One script tag embeds the widget; the initial script is under 50KB gzipped and further assets load lazily. It loads asynchronously without blocking render and needs nothing beyond the workspace key.
- **WIDGET-002 — Visitor identity.** A visitor is identified by a locally stored token created at their first interaction, and keeps conversation history across page loads on the same browser.
- **WIDGET-003 — Email capture.** A visitor may give an email at any time; once given, the visitor is linked to a contact and offline replies are emailed.
- **WIDGET-004 — Availability.** The widget shows operators as available when one has had the inbox open within the last 5 minutes and the current time is within configured hours. Otherwise it shows the configured away message and expected reply time. The availability check identifies the workspace, never the visitor.
- **WIDGET-005 — Appearance.** Colours, position, launcher text, and welcome message are configurable in settings without code.
- **WIDGET-006 — Identified visitors.** The host page may pass a signed user identity. An unsigned or invalid identity is ignored and the visitor stays anonymous; a valid one links the visitor to the matching contact.

## Conversations

- **CONV-001 — States.** A conversation is open or closed. Any customer message except automatic mail (CHAN-008) reopens a closed conversation.
- **CONV-002 — Views.** Operators can list conversations by state, channel, tag, and assignee, sorted by last activity.
- **CONV-003 — Assignment.** New conversations are assigned by the assignment policy; the default leaves them unassigned. Operators can assign and reassign. *Policy: `conversation.assignment.v1`*
- **CONV-004 — Replies and notes.** Operators can send replies, which reach the customer, and notes, which never do. Notes are visually distinct, never sent on any channel, never shown in the widget, and never used for autonomous replies.
- **CONV-005 — Search.** Full-text search over message bodies, subjects, contact names, and emails returns within 500ms.
- **CONV-006 — Tags.** Conversations carry tags. Tags are filterable and exported.
- **CONV-007 — Deletion.** Deleting a conversation removes its messages and attachments. *Policy: `conversation.can-delete.v1`; default: any operator.*
- **CONV-008 — Unread.** A conversation is unread for an operator until they open it after the latest customer message. Unread counts are shown per view.

## Contacts

- **CONTACT-001 — Creation.** A contact is created from the first inbound email, or from a widget visitor once an email is given.
- **CONTACT-002 — Profile.** A contact has name, email, and custom fields. Operators can edit all of them.
- **CONTACT-003 — Unification.** Emails are compared case-insensitively; messages from one address across both channels belong to one contact. Operators can merge two contacts, irreversibly; conversations follow the merge. *Policy: `contact.merge-strategy.v1`*
- **CONTACT-004 — History.** A contact's page lists every conversation with them.
- **CONTACT-005 — Erasure scope.** Deleting a contact removes their conversations, messages, and attachments.
- **CONTACT-006 — Blocking.** An operator can block a contact. Messages from a blocked contact are stored but create no notifications, trigger no AI, and do not reopen conversations. Unblocking restores normal handling.

## AI

- **AI-001 — Drafts on request.** An operator can request a draft for any conversation. It is placed in the reply editor and not sent.
- **AI-002 — Autonomous replies.** When enabled in settings, AI replies to customer messages itself within the rules the autonomy policy sets. Every autonomous reply is labelled as AI in the conversation and in the widget or email. Off by default. *Policy: `ai.autonomy.v1`; default when enabled: reply when a knowledge source answers the question, otherwise hand off.*
- **AI-003 — Handoff.** A customer can ask for a human at any time, and AI hands off whenever the autonomy policy says so. Handoff stops autonomous replies on that conversation, assigns it per CONV-003, and notifies per NOTIFY-001.
- **AI-004 — Context.** Drafts use the conversation history, notes, contact profile, knowledge sources, saved replies, and configured instructions. Autonomous replies use the same without notes. *Policy: `ai.reply-instructions.v1`*
- **AI-005 — Knowledge.** Operators add knowledge sources: URLs, crawled and refreshed on request; uploaded documents; saved replies. Every draft or autonomous reply that draws on a source cites it in the operator view.
- **AI-006 — Triage.** Every customer message is classified against the configured intents and tagged within 10 seconds of arrival. A message matching no intent is left untagged.
- **AI-007 — Language.** A message in a language other than the workspace language is shown with a translation. Drafts and autonomous replies are written in the customer's language.
- **AI-008 — Summaries.** An operator can request a summary of a conversation. It appears in the sidebar and is stored as a note.
- **AI-009 — Provider and failure.** AI calls go through `ai.provider.v1`. If it is unconfigured or failing, drafts show the error, autonomous conversations are handed off per AI-003, triage (AI-006) and translation (AI-007) are skipped, and nothing else is affected.
- **AI-010 — Cost.** Every AI call records model, tokens, and cost. Totals are visible in settings by day and by feature.

## Saved replies

- **REPLY-001 — Library.** Operators create, edit, and delete saved replies with a title and body. Inserting one fills the editor with contact and operator name placeholders resolved.

## Notifications

- **NOTIFY-001 — Needs a human.** Each operator is emailed when a conversation is created or handed off and no autonomous reply was sent, unless they have muted it.
- **NOTIFY-002 — Unattended reply.** When a customer replies, no autonomous reply is sent, and no operator opens the conversation within 5 minutes, the assignee, or every operator if unassigned, is emailed once; further customer messages before an operator opens the conversation do not repeat it.
- **NOTIFY-003 — Assignment.** An operator is emailed when another operator assigns a conversation to them.
- **NOTIFY-004 — No loops.** Notifications are sent from a no-reply address. Mail to that address is discarded and never creates a conversation.

## Data

- **DATA-001 — Export contents.** The export contains every conversation, message, contact, tag, saved reply, knowledge source, setting, and audit entry as JSON, and every attachment as its original file.

## Out of scope

Declared in `seed.json` as non-goals and not tested: multiple workspaces, roles and permissions, SLA and routing rules beyond the assignment and autonomy policies, a public help centre (knowledge sources feed AI only), outbound campaigns and product tours, SMS, phone, and social channels, native mobile apps.
