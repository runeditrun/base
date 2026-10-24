// rer open: open a running checkout in the browser on this computer, signed
// in, from the link rer dev keeps in the checkout's owner-only
// .rer/local/open-url. The link holds the dev key, so it is handed to the
// browser and never printed: output names only the app's address. The browser
// is $BROWSER when set, else `open` (macOS) or `xdg-open` (Linux).
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { locate } from './checkout.mjs';
import { cwdArgument, rerWord } from './cli/invocation.mjs';

const usage = 'Usage: rer open [--cwd DIR]\nOpen this checkout\'s running app in your browser on this computer, signed in. The sign-in link stays between rer and the browser; rer prints only the address.\n';

// The app's name for people: seed.json's name, else none.
export async function productName(root) {
 try { const name = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8')).name; if (typeof name === 'string' && /^[^\n]{1,40}$/.test(name.trim())) return name.trim(); } catch {}
 return undefined;
}

// The saved sign-in link, only from an owner-only regular file of this user.
export async function savedOpenUrl(root) {
 const path = join(root, '.rer/local/open-url');
 let info;
 try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
 if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return undefined;
 const text = (await readFile(path, 'utf8')).trim();
 try { const url = new URL(text); return url.protocol === 'http:' ? url : undefined; } catch { return undefined; }
}

// Start the browser with the link. Resolves { opened, by } once the opener has
// started and, for `open`, answered; never waits for a browser to exit.
export function openInBrowser(url, env = process.env) {
 const browser = env.BROWSER?.trim();
 const [command, ...args] = browser ? browser.split(/\s+/) : [process.platform === 'darwin' ? 'open' : 'xdg-open'];
 return new Promise(resolveOpen => {
  let child, settled = false;
  const done = result => { if (!settled) { settled = true; clearTimeout(timer); child?.unref(); resolveOpen({ ...result, by: command }); } };
  const timer = setTimeout(() => done({ opened: true }), 3000);
  try { child = spawn(command, [...args, String(url)], { stdio: 'ignore', detached: true, env }); }
  catch (error) { done({ opened: false, error: error.code ?? error.message }); return; }
  child.once('error', error => done({ opened: false, error: error.code ?? error.message }));
  child.once('exit', code => done(code === 0 ? { opened: true } : { opened: false, error: `exit ${code}` }));
 });
}

export async function openCommand(args, { shellDirectory = process.cwd() } = {}) {
 if (args.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 const unknown = args.find((arg, index) => !(arg === '--cwd' || args[index - 1] === '--cwd'));
 if (unknown !== undefined || args.filter(arg => arg === '--cwd').length > 1 || (args.includes('--cwd') && !args[args.indexOf('--cwd') + 1])) { process.stderr.write(`Unsupported: rer open ${args.join(' ')}\n${usage}`); return 2; }
 const target = locate(['open', ...args]), word = rerWord();
 if (!target.root || !['first-party'].includes(target.profile)) {
  process.stderr.write(`No Run Edit Run app here. Run rer open in the app's folder, or pass --cwd DIR. Start one with: ${word} dev owner/repo\n`);
  return 3;
 }
 const name = await productName(target.root) ?? basename(target.root), again = cwdArgument(target.root, shellDirectory);
 const url = await savedOpenUrl(target.root);
 const running = url && await fetch(url.origin + '/', { redirect: 'manual', signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
 if (!running) { process.stderr.write(`${name} is not running. Start it with: ${word} dev${again}\n`); return 3; }
 const result = await openInBrowser(url);
 if (!result.opened) {
  process.stderr.write(`Could not start a browser here (${result.by}: ${result.error}). ${name} is running at ${url.origin}. To sign in, open the link saved in ${join(target.root, '.rer/local/open-url')} in a browser on this computer; never share it.\n`);
  return 1;
 }
 process.stdout.write(`Opened ${name} in your browser on this computer: ${url.origin}\n`);
 return 0;
}
