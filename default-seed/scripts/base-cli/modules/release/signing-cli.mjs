import { Refusal, validProject } from './signature.mjs';

const semver = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const versionOK = value => new RegExp(`^${semver}$`).test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)));
const dateOK = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z');
function parse(verb, args) {
  const fields = { sign: ['artifact', 'key-file', 'scope', 'publisher'], receipt: ['artifact', 'anchors', 'environment', 'after'],
    keygen: ['scope', 'publisher', 'github-owner', 'github-owner-id', 'anchor-out', 'not-before', 'not-after', 'unsigned-through'] }[verb];
  const options = { unsignedThrough: {} };
  const invalid = () => { throw new TypeError('ARGUMENT_INVALID'); };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (verb === 'sign' && flag === '--key-stdin' && !options['key-stdin']) { options['key-stdin'] = true; continue; }
    if (!flag.startsWith('--') || !fields.includes(flag.slice(2))) invalid();
    const name = flag.slice(2), value = args[++index];
    if (!value || value.startsWith('--') || (name !== 'unsigned-through' && options[name] !== undefined)) invalid();
    if (name === 'unsigned-through') {
      const match = new RegExp(`^(.+):(${semver})$`).exec(value);
      if (!match || !validProject(match[1]) || !versionOK(match[2]) || Object.hasOwn(options.unsignedThrough, match[1])) invalid();
      options.unsignedThrough[match[1]] = match[2];
    } else options[name] = value;
  }
  if (options.scope !== undefined && !['test', 'rer'].includes(options.scope)) invalid();
  if (verb === 'receipt' && (!options.artifact || !options.anchors || (options.environment !== undefined && options.environment !== 'test') || (options.after && (!new RegExp(`^${semver}:[a-f0-9]{64}$`).test(options.after) || !versionOK(options.after.split(':')[0]))))) invalid();
  if (verb === 'sign' && (!options.artifact || Boolean(options['key-file']) === Boolean(options['key-stdin']))) invalid();
  if (verb === 'sign' && options.publisher !== undefined && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(options.publisher)) invalid();
  if (verb === 'keygen') {
    if (!options.scope || !options['anchor-out'] || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(options.publisher ?? '') || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(options['github-owner'] ?? '') || !/^[1-9]\d*$/.test(options['github-owner-id'] ?? '') || !Number.isSafeInteger(Number(options['github-owner-id']))) invalid();
    for (const name of ['not-before', 'not-after']) if (options[name] !== undefined && !dateOK(options[name])) invalid();
    const start = new Date(options['not-before'] ?? Date.now()), maximum = new Date(start);
    maximum.setUTCFullYear(maximum.getUTCFullYear() + 2);
    if (options['not-after'] && (Date.parse(options['not-after']) <= start.getTime() || Date.parse(options['not-after']) > maximum.getTime())) invalid();
    if (Object.keys(options.unsignedThrough).some(project => !project.startsWith(options.publisher + '/'))) invalid();
    if (process.stdout.isTTY) invalid();
  }
  return options;
}

export async function dispatchSigning(verb, args) {
  let options;
  try { options = parse(verb, args); }
  catch { console.log(JSON.stringify({ verdict: 'REFUSED', code: 'ARGUMENT_INVALID' })); return 2; }
  if (verb === 'sign' && options['key-stdin'] && process.stdin.isTTY) {
    console.log(JSON.stringify({ verdict: 'REFUSED', code: 'ARGUMENT_INVALID', message: 'Pipe the private key from a vault or file; --key-stdin does not accept terminal input.' }));
    return 2;
  }
  try {
    if (verb === 'sign') console.log(await (await import('./sign.mjs')).signArtifact(options));
    else if (verb === 'keygen') await (await import('./keygen.mjs')).keygen(options);
    else { await (await import('./verify.mjs')).receipt(options); console.log(JSON.stringify({ verdict: 'VERIFIED' })); }
    return 0;
  } catch (error) {
    const code = error instanceof Refusal ? error.code : 'STATEMENT_INVALID';
    console.log(JSON.stringify({ verdict: 'REFUSED', code }));
    return 1;
  }
}
