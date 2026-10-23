// rer cli status|install|uninstall
const usage = 'Usage: rer cli status [--json] | rer cli install | rer cli uninstall\n';

export async function cliCommand(args) {
 const [action, ...flags] = args;
 if (!action || args.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 const allowed = action === 'status' ? ['--json'] : [];
 const unknown = flags.find(flag => !allowed.includes(flag));
 if (!['status', 'install', 'uninstall'].includes(action) || unknown !== undefined) { process.stderr.write(`Unsupported: rer cli ${args.join(' ')}\n${usage}`); return 2; }
 if (action === 'status') return (await import('./status.mjs')).status({ json: flags.includes('--json') });
 if (action === 'install') return (await import('./install.mjs')).install();
 return (await import('./uninstall.mjs')).uninstall();
}
