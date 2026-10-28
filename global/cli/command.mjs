// rer cli status|install|uninstall
const usage = 'Usage: rer cli status [--json] | rer cli install | rer cli uninstall | rer cli path\n';

export async function cliCommand(args) {
 const [action, ...flags] = args;
 if (!action || ['--help', '-h'].includes(action)) { process.stdout.write(usage); return 0; }
 const allowed = action === 'status' ? ['--json'] : [];
 const unknown = flags.find(flag => !allowed.includes(flag));
 if (!['status', 'install', 'uninstall', 'path'].includes(action) || unknown !== undefined) { process.stderr.write(`Unsupported: rer cli ${args.join(' ')}\n${usage}`); return 2; }
 if (action === 'status') return (await import('./status.mjs')).status({ json: flags.includes('--json') });
 if (action === 'path') {
  const { pathAdvice } = await import('./path-link.mjs');
  const { layout } = await import('./layout.mjs');
  process.stdout.write((await pathAdvice(layout()) || 'rer is available in this terminal and future terminals.') + '\n');
  return 0;
 }
 if (action === 'install') return (await import('./install.mjs')).install();
 return (await import('./uninstall.mjs')).uninstall();
}
