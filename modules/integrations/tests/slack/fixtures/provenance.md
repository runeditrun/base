# Block Kit fixture provenance

Reviewed live on 2026-10-06. `slack-official-section.json` is the JSON Example 1
from [Slack's section block reference](https://docs.slack.dev/reference/block-kit/blocks/section-block/).
It is independent of this module's templates and validates unchanged.

`block-kit.schema.json` is a JSON Schema transcription of the documented section
and text object field schemas, not a Slack-published downloadable JSON Schema.
Sources: [section fields](https://docs.slack.dev/reference/block-kit/blocks/section-block/),
[text objects](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/),
[message block count](https://docs.slack.dev/reference/block-kit/blocks/),
[message arguments and recommended text size](https://docs.slack.dev/reference/methods/chat.postMessage/).

Scope: section text/fields, block IDs, expand, plain_text and mrkdwn objects,
message text, channel and parsing/unfurl flags. Accessories and all other block
types are intentionally excluded. Text has 1–3000 characters; fields have at most
10 entries of at most 2000 characters; block IDs at most 255; messages at most 50
blocks. Top-level text uses the recommended 4000-character ceiling. The fixture
permits Slack's optional properties even when our smaller serializer does not
emit them. Negative tests independently violate these constraints and invalid
text-type/emoji combinations. AJV performs validation; no product validator is
used as the acceptance oracle.
