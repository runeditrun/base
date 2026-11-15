// The agent verbs: `rer business FAMILY VERB` is one row here. A row names the Business MCP tool it calls, the argument a bare
// word fills (positional), the arguments the call needs (required) and whether --wait follows it to its end (wait). A new
// tool needs one row; `rer business call TOOL --flag value` reaches a tool that has none yet.
export const rows = {
 'installations list': { tool: 'installations.list', about: 'The apps installed for this company, with their state and address' },
 'installation status': { tool: 'installation.status', positional: 'installation_id', required: ['installation_id'], about: 'One installed app: state, version, hosting, progress' },
 'change request': { tool: 'change.request', positional: 'intent', required: ['installation_id', 'intent'], wait: 'change', about: 'Ask for a change to an app, in plain words' },
 'change follow': { tool: 'change.follow', positional: 'change_id', required: ['change_id'], wait: 'change', about: 'Where a requested change is, and what happens next' },
 'change publish': { tool: 'change.publish', positional: 'change_id', required: ['change_id'], about: 'Publish a change whose preview is ready' },
 'update list': { tool: 'update.list', positional: 'installation_id', required: ['installation_id'], about: 'Updates available for an app' },
 'update prepare': { tool: 'update.prepare', positional: 'installation_id', required: ['installation_id'], about: 'Prepare the app for its next update' },
 'update build': { tool: 'update.build', positional: 'installation_id', required: ['installation_id', 'preparation_id'], about: 'Build a prepared update' },
 'update follow': { tool: 'update.follow', positional: 'installation_id', required: ['installation_id'], wait: 'update', about: 'Where an update is' },
 'domain set': { tool: 'domain.set', positional: 'domain', required: ['domain'], about: "Set the company's domain" },
 'domain prove': { tool: 'domain.prove', required: ['method'], about: 'Prove the domain: --method txt|cloudflare' },
 'domain attach': { tool: 'domain.attach', positional: 'hostname', required: ['installation_id', 'surface', 'hostname'], about: 'Give an app surface a hostname (--public-path optional)' },
 'domain records': { tool: 'domain.records', positional: 'installation_id', required: ['installation_id'], about: 'The DNS records an app needs' },
 'domain check': { tool: 'domain.check', required: ['installation_id', 'domain_id'], about: 'Check that a domain is attached and answering' },
 'domain remove': { tool: 'domain.remove', required: ['installation_id', 'domain_id'], about: 'Detach a domain from an app' },
 'import start': { tool: 'import.start', positional: 'installation_id', required: ['installation_id'], about: "Start moving an old tool's data into an app" },
 'import follow': { tool: 'import.follow', positional: 'installation_id', required: ['installation_id'], about: 'Where an import is' },
 'profile set': { tool: 'business.profile.set', required: ['profile'], about: 'Save the business profile: --profile JSON or --profile @FILE' },
 'plan draft': { tool: 'plan.draft', about: 'Draft the plan: --FIELD VALUE, or --args JSON' },
 'plan read': { tool: 'plan.read', about: 'Read the plan' },
 'plan request-approval': { tool: 'plan.request_approval', about: 'Ask the owner to approve the plan' },
 'app owner-signed-in': { tool: 'app.owner_signed_in', positional: 'installation_id', required: ['installation_id'], about: 'Has the owner signed in to the app yet' },
 'app send-sign-in-link': { tool: 'app.send_sign_in_link', positional: 'installation_id', required: ['installation_id'], about: 'Email the owner a sign-in link to the app' },
};
// Short flag names for argument names, so `--app ID` is `--installation-id ID`.
export const aliases = { app: 'installation_id' };
export const families = [...new Set(Object.keys(rows).map(name => name.split(' ')[0]))];
export const agentFamilies = new Set([...families, 'tools', 'mcp', 'call']);
