# Public command points

All commands ran without provider/customer data, setup, installation or a running app.

| Point | Command | Exit and output |
| --- | --- | --- |
| 1 | `node default-seed/scripts/rer.mjs check --cwd default-seed --json` | 0; full output in point-export-check.json |
| 2 | `node default-seed/scripts/rer.mjs describe --cwd default-seed --json` | 0; cliVersion 0.2.100-dev.g32682133; full output in point-vendored-describe.json |
| 3 | `node scripts/rer-package.mjs --out PACKED_DIST` | 0; deterministic tarball built from C; binding/digest in package-receipt.json |
| 4 | `node PACKED_PACKAGE/global/rer.mjs --version` | 0; 0.2.100-dev.g105902c3 |
| 5 | `node PACKED_PACKAGE/bin/rer.mjs --help` | 0; full output in point-packed-help.txt |
| 6 | `node PACKED_PACKAGE/bin/rer.mjs describe --cwd default-seed --json` | 0; cliVersion 0.2.100-dev.g105902c3; full output in point-packed-describe.json |
| 7 | `node PACKED_PACKAGE/bin/rer.mjs business --help` | 0; Zendesk credential JSON and vendor-key command documented in point-vendor-help.txt |

Strategy vendor-keys card: `rer business vendor-key add zendesk`. The owner enters the read-only OAuth client JSON at its hidden terminal prompt, never in chat, arguments or environment. No key command was executed. CLI source: cli/README.md, Zendesk offline snapshots; cli/business/command.mjs, vendor-key help.
