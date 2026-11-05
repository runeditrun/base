import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { createCredentialStore } from './keychain.mjs';

const keyHelp = `Usage: rer business receipt-key create KEY_ID
Generate an Ed25519 signing key in OS credential storage and print its SPKI
public key only. Existing key IDs are refused. No private key file is written.
Configure the public key in BUSINESS_IMPORTER_TRUST_KEYS with environments:["stage"].
Exits 0 created, 1 refused, 2 usage.
`;
const signHelp = `Usage: rer business receipt sign --manifest FILE --evidence FILE --key-id ID --output FILE
Sign a v1 importer verification receipt from kept export metadata and reviewed
import evidence. Synthetic or inconsistent claims are refused. Verify under a
stage policy before creating the output; an existing output is never replaced.
This command does not capture an export, run an import or establish acceptance.
Exits 0 written, 1 refused, 2 usage.
`;
const evidenceMembers = ['product', 'candidate', 'mapping', 'command', 'runs', 'reconciliation', 'unmapped', 'research', 'review'];
const keyIdValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const helpRequested = args => args.length === 1 && ['--help', '-h'].includes(args[0]);

export async function receiptKeyCommand(args) {
 if (helpRequested(args) || args[0] === 'create' && helpRequested(args.slice(1))) { process.stdout.write(keyHelp); return 0; }
 if (args.length !== 2 || args[0] !== 'create' || !keyIdValid(args[1])) { process.stderr.write(keyHelp); return 2; }
 try {
  const store = createCredentialStore(), handle = `receipt:${args[1]}:sign`;
  if (await store.get(handle) !== null) throw new Error();
  const keys = generateKeyPairSync('ed25519');
  const bytes = keys.privateKey.export({ type: 'pkcs8', format: 'der' });
  try { await store.set(handle, bytes.toString('base64')); }
  finally { bytes.fill(0); }
  process.stdout.write(keys.publicKey.export({ type: 'spki', format: 'pem' }));
  return 0;
 } catch {
  // OS diagnostics can contain key material. Only fixed text leaves this boundary.
  process.stderr.write('Receipt key creation refused; check key ID and OS credential storage.\n');
  return 1;
 }
}

export async function receiptCommand(args) {
 if (helpRequested(args) || args[0] === 'sign' && helpRequested(args.slice(1))) { process.stdout.write(signHelp); return 0; }
 const options = {};
 if (args[0] !== 'sign' || args.length !== 9) { process.stderr.write(signHelp); return 2; }
 for (let index = 1; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!['--manifest', '--evidence', '--key-id', '--output'].includes(name) || !value || value.startsWith('-') || Object.hasOwn(options, name)) {
   process.stderr.write(signHelp); return 2;
  }
  options[name] = value;
 }
 if (!keyIdValid(options['--key-id'])) { process.stderr.write(signHelp); return 2; }
 try {
  const manifest = JSON.parse(await readFile(options['--manifest'], 'utf8'));
  const evidence = JSON.parse(await readFile(options['--evidence'], 'utf8'));
  // The kept metadata supplies source claims. Evidence cannot override them or
  // smuggle in extra signed members. Nested members face the existing v1 schema.
  if (manifest?.synthetic !== false || manifest?.source?.classification !== 'authorized-real-export'
    || !evidence || Array.isArray(evidence) || Object.keys(evidence).length !== evidenceMembers.length
    || !evidenceMembers.every(member => Object.hasOwn(evidence, member))) throw new Error();
  const payload = {
   incumbent: manifest.incumbent, synthetic: manifest.synthetic, adapter: manifest.adapter,
   source: manifest.source, ...evidence,
  };
  const keyId = options['--key-id'];
  const secret = await createCredentialStore().get(`receipt:${keyId}:sign`);
  if (!secret) throw new Error();
  const bytes = Buffer.from(secret, 'base64');
  let privateKey, publicKey;
  try {
   const key = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' });
   if (key.asymmetricKeyType !== 'ed25519') throw new Error();
   publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
   privateKey = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', false, ['sign']);
  } finally { bytes.fill(0); }
  const { signImporterVerificationReceipt, verifyImporterVerificationReceipt } = await (await import('./receipt-runtime.mjs')).loadReceiptApi();
  const receipt = await signImporterVerificationReceipt(payload, keyId, privateKey);
  const policy = { environment: 'stage', keys: { [keyId]: { publicKey, environments: ['stage'] } } };
  if (!(await verifyImporterVerificationReceipt(receipt, policy)).valid) throw new Error();
  // Exclusive creation also refuses symlinks and an output aliasing either input.
  const output = await open(options['--output'], 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); }
  catch (error) { await unlink(options['--output']); throw error; }
  finally { await output.close(); }
  process.stdout.write('Importer verification receipt written.\n');
  return 0;
 } catch {
  process.stderr.write('Receipt signing refused; check manifest, evidence, key and output.\n');
  return 1;
 }
}
