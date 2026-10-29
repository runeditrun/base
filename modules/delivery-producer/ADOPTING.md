# One mail sender

Managed mail declares one public `MAIL_FROM` binding in the delivery policy,
Wrangler variables and setup manifest. Keep the provider credential in
`MAIL_API_KEY`, declared as a secret. An empty sender default means the input is
unconfigured; it is not a second sender.

Existing deploy adapters may supply that same public binding through a
`deploy.json` secret entry and its explicit environment mapping. `rer check`
accepts this overlap only when the delivery policy declares managed mail and
public `MAIL_FROM`; other variable/secret overlaps remain refused. Do not also
classify `MAIL_FROM` as a delivery secret. No new sender field is needed.

Keep configured sender values identical across deploy variables, source and
emitted Wrangler variables, delivery projections and deploy environment inputs.
`rer check`, artifact production and deploy preflight refuse differing values,
naming both senders and their declaration sources. A deploy `verifyStandIn` is
only a disposable verification value, not a production sender declaration.

Refresh the CLI and any copied delivery producer together. Regenerate the
edition's delivery projection with its normal build and packaging command;
retain its existing setup manifest, owner identity and provider authorization.
This change does not repair agent conformance fixtures or archive ancestry.
