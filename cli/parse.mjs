import { resolve } from 'node:path';
import { commonFlags, demoVerb, serverDefaults, signinVerb, verbs } from './contract.mjs';
import { invalid, refuse } from './errors.mjs';
import { isLoopbackHost } from '../modules/operator-auth/loopback.mjs';
import { normalizeEmail } from '../modules/operator-auth/policy.mjs';
const booleans = new Set(['--help', '--json', '--non-interactive', '--yes', '--dry-run', '--stop', '--detach', '--foreground', '--no-queue', '--login', '--legacy-v1', '--acknowledge-unverified-metadata', '--door', '--direct', '--site', '--remove', '--demo']);
export const mailbox = value => typeof value === 'string' && value.length <= 254 && /^[a-zA-Z0-9.!+_%\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+$/.test(value);
export const validOwnerName = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);
// A loopback host: the shared predicate (including `*.localhost` door names),
// plus `::1` as --host and a bracket-stripped hostname spell it.
export const loopback = host => host === '::1' || isLoopbackHost(host);
// The addresses rer binds directly. A `*.localhost` name is reached through the
// front door; binding one would give a `::1`-only listener on macOS.
export const listenHost = host => ['127.0.0.1', 'localhost', '::1'].includes(host);
export const origin = (host, port) => `http://${host === '::1' ? '[::1]' : host}:${port}`;

export function parse(argv, cwd = process.cwd(), { independent = false, deferTail = false, demo = false } = {}) {
 const [verb, ...args] = argv;
 if (!verb || verb === '--help') return { help: true };
 if (verb === 'listing') return { verb, listingArgs: args };
 // Release validates its own flags, including its integer publication scan timeout.
 if (verb === 'release') return { verb, releaseArgs: args };
 if (verb === 'archive') return { verb, archiveArgs: args };
 // rer demo is rer dev --demo, taking only the flags a demo accepts; its help
 // and refusals name demo.
 if (verb === 'demo' && !independent) {
  const options = parse(['dev', '--demo', ...args], cwd, { independent, deferTail, demo: true });
  return options.help ? { ...options, verb: 'demo' } : options;
 }
 // Independent projects own verb names; only the common wrapper flags apply
 // to unknown names. Profile resolution rejects undeclared commands later.
 if (!/^[a-z][a-z0-9-]*$/.test(verb)) throw invalid('Unknown rer command. Run rer --help.');
 const name = demo ? 'demo' : verb;
 // The flags this verb's help lists; rer demo also carries the --demo it adds itself.
 const helpFlags = independent ? [...commonFlags,...(['install','setup','build','verify','deploy','release','export','import','dev','preview'].includes(verb)?['--no-queue']:[])] : demo ? demoVerb.flags : (verbs[verb] ?? (verb === 'signin' ? signinVerb : undefined))?.flags ?? commonFlags;
 const allowed = new Set(demo ? ['--demo', ...helpFlags] : helpFlags), options = { verb, cwd: resolve(cwd), forwarded: [], supplied: new Set() };
 let separator = false;
 for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--') { if (separator) throw invalid('Use only one -- separator.'); separator = true; if (independent || deferTail) { options.forwarded = args.slice(i + 1); break; } continue; }
  if (separator && !flag.startsWith('--')) { options.forwarded.push(...args.slice(i)); break; }
  // pnpm run VERB -- FLAGS forwards the separator before wrapper flags.
  if (separator && !allowed.has(flag) && !flag.startsWith('--')) { options.forwarded.push(...args.slice(i)); break; }
  if (!allowed.has(flag)) {
   if(flag==='--strictPort')throw invalid('Unsupported --strictPort. Use --port PORT; strict port binding is automatic.');
   // Only a well-formed flag is echoed: anything else, or a value after =, may be a value typed in the wrong place.
   const [, typed, value] = /^--([a-zA-Z0-9_-]{1,40})(=.*)?$/s.exec(flag) ?? [];
   if(typed===undefined)throw invalid(`Unsupported argument for ${name}: rer ${name} takes only the flags its help lists. Run rer ${name} --help.`);
   const suggestion=nearMiss(typed,helpFlags,name),hint=suggestion?` Did you mean ${suggestion}?`:'';
   throw invalid(value===undefined?`Unsupported flag ${flag} for ${name}.${hint} Run rer ${name} --help.`:`Unsupported argument for ${name}: give a flag's value after a space, not after =.${hint} Run rer ${name} --help.`);
  }
  // Several secrets change in one deploy: --set-secret A --set-secret B is --set-secret A,B.
  const listed = ['--set-secret', '--unset-secret'].includes(flag);
  if (options.supplied.has(flag) && !listed) throw invalid(`Repeated flag ${flag} for ${name}. Run rer ${name} --help.`);
  options.supplied.add(flag);
  const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (booleans.has(flag)) options[key] = true;
  else {
   const value = args[++i];
   if (value === undefined || value.startsWith('--') || !value.trim()) throw invalid(`A value is required for ${flag}.`);
   options[key] = listed && options[key] !== undefined ? `${options[key]},${value}` : value;
  }
 }
 if (options.help) return options;
 if (deferTail) { options.cwd=resolve(cwd,options.cwd);return options; }
 if (options.detach && options.foreground) throw invalid('Choose one of --detach and --foreground.');
 if(options.stop && ['--port','--host','--idle-timeout','--detach','--foreground','--no-queue','--as','--login','--models','--models-service','--door','--direct'].some(flag=>options.supplied.has(flag)))throw invalid('--stop cannot be combined with start-only flags.');
 // --port and --host always mean direct mode; --door and --direct pick a mode.
 if(options.door&&options.direct)throw invalid('Choose one of --door and --direct.');
 if(options.door&&['--port','--host'].some(flag=>options.supplied.has(flag)))throw invalid('--door cannot be combined with --port or --host, which always serve directly.');
 if(options.models!==undefined && !['fake','live'].includes(options.models))throw invalid('--models takes fake or live.');
 if(options.modelsService!==undefined && options.models!=='live')throw invalid('--models-service requires --models live.');
 if(options.as!==undefined) {
  if(options.as.includes('@')) {
   try { options.as=normalizeEmail(options.as); }
   catch { throw invalid('--as takes a persona name or an invited person\'s email.'); }
  }
  else if(!/^[a-z][a-z0-9-]{0,39}$/.test(options.as))throw invalid('--as takes a persona name or an invited person\'s email.');
 }
 // rer dev --demo takes what rer demo takes.
 const notDemo=verb==='dev'&&options.demo?[...options.supplied].find(flag=>flag!=='--demo'&&!demoVerb.flags.includes(flag)):undefined;
 if(notDemo)throw invalid(`A demo opens signed in as the owner on its own data and takes only the flags rer demo --help lists, not ${notDemo}.`);
 if(['dev','preview'].includes(verb) && !options.stop){
  // A demo ends one hour after it starts unless --idle-timeout says otherwise.
  const value=options.idleTimeout??(options.demo?'3600':process.env.RER_SERVER_IDLE_SECONDS??String(serverDefaults.idleSeconds));
  if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value)))throw invalid('Idle timeout must be positive integer seconds.');
  options.idleTimeout=Number(value);
 }
 if (options.port !== undefined) {
  if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) throw invalid('Port must be a decimal integer from 1 to 65535.');
  options.port = Number(options.port);
 }
 for(const key of ['httpPort','httpsPort'])if(options[key]!==undefined){if(!/^[0-9]+$/.test(options[key])||Number(options[key])<1||Number(options[key])>65535)throw invalid('Ingress port must be an integer from 1 to 65535.');options[key]=Number(options[key]);}
 if(options.site&&['platform','image','bindAddress','httpPort','httpsPort','envFile','host'].some(key=>options[key]!==undefined))throw invalid('--site takes no platform, container or host flags: the run site is static files on an assets-only Worker.');
 if(['image','bindAddress','httpPort','httpsPort'].some(key=>options[key]!==undefined)&&options.platform!=='container')throw invalid('Container image and ingress flags require --platform container.');
 if(options.platform !== undefined && !['workers','container'].includes(options.platform))throw invalid('Platform must be workers or container.');
 if (options.host !== undefined && !(verb === 'deploy' && options.platform === 'container') && !listenHost(options.host)) throw refuse('Host must be exactly 127.0.0.1, localhost or ::1.');
 if (options.ownerEmail !== undefined) { if (!mailbox(options.ownerEmail)) throw invalid('Provide a valid plain owner mailbox.'); options.ownerEmail = options.ownerEmail.toLowerCase(); }
 if (options.ownerName !== undefined && !validOwnerName(options.ownerName)) throw invalid('Provide a valid owner name.');
 if (options.target !== undefined && !['local', 'remote'].includes(options.target)) throw invalid('Target must be local or remote.');
 if (options.profile !== undefined && options.profile !== 'first-party') throw invalid('The supported explicit profile is first-party.');
 if (options.environment !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(options.environment)) throw invalid('Provide a valid deployment environment name.');
 for (const key of ['setSecret', 'unsetSecret']) if (options[key] !== undefined) {
  const names = [...new Set(options[key].split(','))];
  if (names.length > 16 || !names.every(name => /^[A-Z][A-Z0-9_]{0,63}$/.test(name))) throw invalid(`--${key === 'setSecret' ? '' : 'un'}set-secret names declared secret bindings, repeated or separated by commas, such as SESSION_SECRET or MAIL_API_KEY,MAIL_FROM.`);
  options[key] = names.join(',');
 }
 if (options.rotateSecret !== undefined && !/^[A-Z][A-Z0-9_]{0,63}(?:,[A-Z][A-Z0-9_]{0,63}){0,15}$/.test(options.rotateSecret)) throw invalid('--rotate-secret names generated secret bindings, separated by commas, such as SESSION_SECRET.');
 if (options.reopenInstallationKey !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.reopenInstallationKey)) throw invalid('--reopen-installation-key takes the installation key ID from a sealed envelope or private retired custody.');
 if(verb==='deploy'&&options.demo&&(options.site||['platform','image','bindAddress','httpPort','httpsPort','envFile','host','setSecret','unsetSecret','rotateSecret','reopenInstallationKey'].some(key=>options[key]!==undefined)))throw invalid('--demo takes only --environment, --dry-run and --remove --yes: the hosted demo is its own Worker on demo.<domain>.');
 if(verb==='deploy'&&options.demo&&options.remove&&(options.dryRun||!options.yes))throw invalid(options.dryRun?'Use --remove and --dry-run on separate runs.':'deploy --demo --remove deletes the hosted demo\'s Worker, its demo.<domain> Custom Domain. Add --yes to confirm.');
 if ((options.remove || options.setSecret || options.unsetSecret || options.rotateSecret || options.reopenInstallationKey) && options.site) throw invalid('--remove, --set-secret, --unset-secret, --rotate-secret and --reopen-installation-key act on the application Worker, not the run site.');
 if (options.origin !== undefined) {
  let url; try { url = new URL(options.origin); } catch { throw invalid('Provide a valid credential-free origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid('Provide a credential-free HTTP origin without a path.');
 }
 if (options.cwd !== undefined) options.cwd = resolve(cwd, options.cwd);
 return options;
}

export function help(verb) {
 if (!verb) return `Usage: rer VERB [FLAGS]\nCommands: ${Object.keys(verbs).join(', ')}, demo, signin, release, listing, archive\nRun rer VERB --help for flags.\n`;
 const known = verb === 'demo' ? demoVerb : verbs[verb] ?? (verb === 'signin' ? signinVerb : undefined);
 const door = ['export', 'import'].includes(verb) ? 'To move records, start the app and open its signed-in owner import door:\n\n  rer dev\n\nOpen /app/import, then export or upload and review supported records there.\n\nTo back up or restore this installation:\n' : '';
 return `${door}Usage: rer ${verb} [FLAGS]\nFlags: ${(known?.flags ?? commonFlags).join(', ')}\n${known?.effects ?? 'Execute the declared OPERATIONS v2 argv with explicit arguments after --.'}\n`;
}

// What people type for a flag whose name qualifies it, on a verb where it can
// mean nothing else (--name for setup's --owner-name, not deploy's). Never accepted.
const shortNames = { setup: { email: '--owner-email', name: '--owner-name' }, ...Object.fromEntries(['dev', 'preview', 'demo'].map(verb => [verb, { timeout: '--idle-timeout' }])) };

// The one flag the verb's help lists that a typed name nearly is, if any. In lower
// case with _ read as -, the name is one edit from that flag's name or short name
// (an edit adds or drops a letter or swaps two neighbouring letters; a name of nine
// letters or more allows two, a two-letter name none), or it is the flag's leading
// words and the start of no other flag (--legacy for --legacy-v1). A tie or anything
// else suggests nothing.
function nearMiss(typed,listed,verb){
 const spelled=typed.toLowerCase().replaceAll('_','-');
 const spellings=[...listed.map(flag=>[flag.slice(2),flag]),...Object.entries(shortNames[verb]??{}).filter(([,flag])=>listed.includes(flag))];
 const near=spellings.map(([spelling,flag])=>({flag,edits:distance(spelled,spelling),allowed:spelling.length>=9?2:spelling.length>=3?1:0})).filter(({edits,allowed})=>edits<=allowed);
 const fewest=Math.min(...near.map(({edits})=>edits)),closest=new Set(near.filter(({edits})=>edits===fewest).map(({flag})=>flag));
 if(near.length)return closest.size===1?[...closest][0]:undefined;
 const started=listed.filter(flag=>flag.startsWith(`--${spelled}`));
 return started.length===1&&started[0].startsWith(`--${spelled}-`)?started[0]:undefined;
}
// Optimal string alignment distance where an adjacent swap is one edit and a
// changed letter two: one changed letter often spells another word (--remote, --remove).
function distance(a,b){const d=Array.from({length:a.length+1},(_,i)=>Array.from({length:b.length+1},(_,j)=>i||j));for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:2));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);}return d[a.length][b.length];}
