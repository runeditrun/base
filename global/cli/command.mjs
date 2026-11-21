import { withCommandHelp } from '../../cli/command-guidance.mjs';
import { launcherCommand, layout } from './layout.mjs';
// rer cli status|install|uninstall
const usage = 'Usage: ~/.local/bin/rer cli status [--json] | ~/.local/bin/rer cli install | ~/.local/bin/rer cli uninstall | ~/.local/bin/rer cli path\n';

export async function cliCommand(args) {
 const [action, ...flags] = args;
 const help = text => {
  const launcher = launcherCommand(layout());
  return withCommandHelp(text).replaceAll('~/.local/bin/rer', () => launcher);
 };
 if (!action || ['--help', '-h'].includes(action)) { process.stdout.write(help(usage) + '\n'); return 0; }
 const allowed = action === 'status' ? ['--json'] : [];
 const unknown = flags.find(flag => !allowed.includes(flag));
 if (!['status', 'install', 'uninstall', 'path'].includes(action) || unknown !== undefined) { process.stderr.write(help(`Unsupported: ~/.local/bin/rer cli ${args.join(' ')}\n${usage}`) + '\n'); return 2; }
 if (action === 'status') return (await import('./status.mjs')).status({ json: flags.includes('--json') });
 if (action === 'path') {
  const { shellStartup } = await import('./path-link.mjs');
  process.stdout.write(shellStartup(layout()).line + '\n');
  return 0;
 }
 if (action === 'install') return (await import('./install.mjs')).install();
 return (await import('./uninstall.mjs')).uninstall();
}
