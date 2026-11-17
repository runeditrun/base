import { rows, families } from './agent-table.mjs';

const verb = name => name.split(' ')[1];
const exits = `Exits 0 done, 1 refused or failed (the server's message is printed), 2 usage, 3 not built yet, 75 still working when\n--timeout ran out. A verb the owner has not granted this computer names where the owner grants it: Business, under Computers.`;
const flags = `
  --app ID, --installation-id ID   The installed app (from ~/.local/bin/rer business installations list)
  --FLAG VALUE                     Any other flag is an argument of the tool: --change-id, --preparation-id,
                                   --domain-id, --request-key, --method, --surface, --hostname, --public-path
                                   (kebab-case becomes snake_case). A value that starts with { or [ is JSON;
                                   @FILE reads a file. --args JSON gives the whole arguments object
  --json                           Print the tool's structuredContent as JSON (progress goes to stderr)
  --wait, --timeout SECONDS, --interval SECONDS
                                   Follow to the end where the verb supports it (default 1800 s, polling every 15 s)
${exits}`;

/** The lines the advanced-commands help adds for the agent verbs. */
export const agentUsage = `
Agent verbs (Usage: ~/.local/bin/rer business FAMILY VERB [--flags] [--json])
Act on the company's installed apps from this computer, with no browser. Needs ~/.local/bin/rer business connect first.
${Object.entries(rows).map(([name, row]) => `  ${name.padEnd(24)} ${row.about}`).join('\n')}
  tools                    List the tools the Business server offers
  call TOOL [--flags]      Call a tool that has no verb of its own yet
  mcp                      A local stdio MCP server for Claude Code or Codex: add \`~/.local/bin/rer business mcp\` as a server
                           and the agent never handles a token
  change request --app ID "WHAT TO CHANGE" [--wait] [--publish]
                           --wait follows the change to its preview; --publish also publishes it and waits for live
${exits}
`;

const family = name => Object.entries(rows).filter(([key]) => key.split(' ')[0] === name)
 .map(([key, row]) => `  ${verb(key).padEnd(22)} ${row.about}`).join('\n');
const help = name => `Usage: ~/.local/bin/rer business ${name} VERB [--flags] [--json]
${family(name)}
${flags}
`;

export const agentHelp = {
 ...Object.fromEntries(families.map(name => [name, help(name)])),
 tools: `Usage: ~/.local/bin/rer business tools [--json]
List the tools the Business server offers: name and a one-line description. Use ~/.local/bin/rer business call TOOL to call one that has no verb.
`,
 call: `Usage: ~/.local/bin/rer business call TOOL [--flag VALUE ...] [--args JSON] [--json]
Call any Business tool by name, such as installation.status. Flags become the tool's arguments (kebab-case to snake_case).
Exits 0 done, 1 refused or failed, 3 not built yet.
`,
 mcp: `Usage: ~/.local/bin/rer business mcp
Run a local MCP server on stdin and stdout (newline-delimited JSON-RPC, revision 2025-11-25) that forwards to the Business
MCP. It keeps the short-lived bearer fresh from this computer's pairing, so the agent that starts it never handles a token.
Claude Code: claude mcp add business -- ~/.local/bin/rer business mcp
Codex: add [mcp_servers.business] with command = "rer" and args = ["business", "mcp"]
Needs ~/.local/bin/rer business connect first. Only protocol messages go to stdout; diagnostics go to stderr.
`,
};
