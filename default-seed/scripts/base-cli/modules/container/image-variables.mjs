import {readFile} from 'node:fs/promises';
import {deliveryDeclarationSources} from '../../cli/delivery-declarations.mjs';
import {switchableDefaults} from '../../cli/deploy-settings.mjs';
import {sourcePath} from '../delivery-producer/migrations.mjs';
import {publicMailSender} from '../delivery-producer/mail.mjs';

/** Shared binding comparison for source checks and emitted image validation. */
export function imageVariableSecrets(vars, secrets) {
 return secrets.filter(secret => Object.hasOwn(vars, secret.binding));
}

/**
 * The one rule for a name that is both a Wrangler var and a deploy secret, used by
 * the source check and the image build. It is public only as a switchable public
 * setting (deploy-settings) whose var keeps the declared default, or as a managed
 * mail spec's public MAIL_FROM sender. A managed artifact's secret or optional
 * secret name is always private. Returns binding, value -> 'public' | 'mismatch' | 'private'.
 */
export async function overlapRule(root, declaration) {
 const defaults = await switchableDefaults(declaration);
 const privateNames = new Set();
 let publicSender = false;
 for (const [candidate, select] of deliveryDeclarationSources) {
  const path = await sourcePath(root, candidate, {optional: true});
  if (!path) continue;
  const spec = select(JSON.parse(await readFile(path, 'utf8')));
  if (!spec) continue;
  for (const name of [...(spec.secretNames ?? []), ...(spec.optionalSecretNames ?? [])]) privateNames.add(name);
  publicSender ||= publicMailSender(spec);
 }
 return (binding, value) => {
  if (privateNames.has(binding)) return 'private';
  if (Object.hasOwn(defaults, binding)) return value === defaults[binding] ? 'public' : 'mismatch';
  return binding === 'MAIL_FROM' && publicSender ? 'public' : 'private';
 };
}

/** Drop empty runtime-secret placeholders; keep only public overlaps as image defaults. */
export async function checkImageVariables(root, vars, declaration) {
 const declared = imageVariableSecrets(vars, declaration.secrets ?? []);
 const placeholders = declared.filter(secret => vars[secret.binding] === '');
 const overlaps = declared.filter(secret => vars[secret.binding] !== '');
 if (overlaps.length) {
  const rule = await overlapRule(root, declaration);
  for (const {binding} of overlaps) {
   const kind = rule(binding, vars[binding]);
   if (kind === 'mismatch') throw new Error(`${binding}: the image variable must match the public default in the deploy declaration's vars.${binding}`);
   if (kind !== 'public') throw new Error('Secret declared as an image variable: ' + binding);
  }
 }
 for (const {binding} of placeholders) delete vars[binding];
}
