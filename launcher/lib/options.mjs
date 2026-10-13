import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const catalog = Object.freeze({
  happytohelp: 'https://github.com/just-every/run-happytohelp.git',
  lamp: 'https://github.com/just-every/run-lamp.git',
  orbit: 'https://github.com/just-every/run-orbit.git',
  ferry: null,
  beacon: null,
});

export const help = `Usage: rer-setup <happytohelp|lamp|orbit|ferry|beacon> [options]
  --directory PATH       Durable checkout (default: ./<seed>); must not exist
  --repository SOURCE    Use an explicitly trusted HTTPS, SSH or local Git source
  --ref REF              Fetch a branch, tag or commit (default: remote HEAD)
  --resume               Reopen a launcher-owned checkout without fetching/resetting
  --agent --no-open --no-prefill --port PORT --answers FILE --secrets-stdin
                         Passed to the seed's existing installer
Requires Node 22+ and Git. Opening setup does not install or deploy the app.
Ferry and Beacon are retired and require --repository (or --resume).
Custom repositories execute their scripts/install.mjs: use source you trust.`;

export function repositorySource(value, cwd) {
  if (!value || /[\x00-\x20\x7f]/.test(value) && !value.startsWith('/') && !value.startsWith('./') && !value.startsWith('../')) {
    throw Error('Repository must be an HTTPS URL, SSH URL or local Git path.');
  }
  if (/[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) throw Error('Unsafe repository value.');
  if (value.startsWith('file://')) return resolve(fileURLToPath(value));
  if (/^(https|ssh):\/\//.test(value)) {
    const url = new URL(value);
    if (!url.hostname || url.password || url.search || url.hash || (url.protocol === 'https:' && url.username)) {
      throw Error('Repository URLs must not contain credentials, queries or fragments; use existing Git authentication.');
    }
    return value;
  }
  if (/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (value.includes('://') || value.includes('::')) throw Error('Unsupported repository protocol.');
  return resolve(cwd, value);
}

export function parseArgs(args, cwd = process.cwd()) {
  const options = { installerArgs: [], resume: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg) && arg.startsWith('--')) throw Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (['--agent', '--no-open', '--no-prefill', '--secrets-stdin'].includes(arg)) options.installerArgs.push(arg);
    else if (arg === '--resume') { options.resume = true; options.installerArgs.push(arg); }
    else if (['--directory', '--repository', '--ref', '--answers', '--port'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${arg}.`);
      if (arg === '--directory') options.directory = resolve(cwd, value);
      if (arg === '--repository') options.repository = repositorySource(value, cwd);
      if (arg === '--ref') {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) throw Error('Use a branch, tag or commit for --ref.');
        options.ref = value;
      }
      if (arg === '--answers') options.installerArgs.push(arg, resolve(cwd, value));
      if (arg === '--port') {
        if (!/^\d+$/.test(value) || Number(value) > 65535) throw Error('--port must be between 0 and 65535.');
        options.installerArgs.push(arg, value);
      }
    } else if (!arg.startsWith('-') && !options.seed) options.seed = arg.toLowerCase();
    else throw Error('Unknown argument. Use --help for launcher options.');
  }
  if (!Object.hasOwn(catalog, options.seed)) throw Error('Choose a supported seed: happytohelp, lamp, orbit, ferry or beacon.');
  if (!options.resume && !options.repository && !catalog[options.seed]) throw Error(`${options.seed} is retired; supply --repository with a trusted source or --resume for an existing checkout.`);
  if (seen.has('--no-prefill') && ['--resume', '--answers', '--secrets-stdin'].some(flag => seen.has(flag))) throw Error('--no-prefill cannot be combined with --resume, --answers or --secrets-stdin.');
  options.directory ||= resolve(cwd, options.seed);
  return options;
}
