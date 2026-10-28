import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

const defaultEmail = 'synthetic-base-1@example.com';

const ownerBindingValues = ['issuer', 'installationId', 'appOrigin', 'publicKeys', 'email', 'sub', 'token', 'sessionSecret'];

export async function verificationOwner(root, value = {}) {
 if (!value || typeof value !== 'object' || Array.isArray(value)
  || Object.keys(value).some(key => !['email', 'emailField', 'tokenField', 'bindings', 'initializer'].includes(key))) throw new RerError('agent_owner_invalid', 'verification.owner must declare only email, emailField, tokenField, bindings and initializer.', 1);
 const email = value.email ?? defaultEmail;
 if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new RerError('agent_owner_invalid', 'verification.owner.email must be a canonical owner email.', 1);
 for (const key of ['emailField', 'tokenField']) if (value[key] !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value[key])) throw new RerError('agent_owner_invalid', `verification.owner.${key} must name a production binding.`, 1);
 if (value.bindings !== undefined && (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
  || Object.entries(value.bindings).some(([name, source]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !ownerBindingValues.includes(source)))) throw new RerError('agent_owner_invalid', `verification.owner.bindings must map native binding names to ${ownerBindingValues.join(', ')}.`, 1);
 let initialize;
 if (value.initializer !== undefined) {
  await contained(root, value.initializer);
  initialize = (await import(pathToFileURL(resolve(root, value.initializer)))).default;
  if (typeof initialize !== 'function') throw new RerError('agent_owner_invalid', 'verification.owner.initializer must default-export an async owner initializer.', 1);
 }
 return { ...value, email, initialize };
}

function finish(result, report) {
 for (const point of result.points) report(`${point.ok ? 'PASS' : 'FAIL'} ${point.id}${point.ok || !point.detail ? '' : `: ${point.detail}`}`);
 const failed = result.points.filter(point => !point.ok).map(point => point.id);
 report(`Agent door conformance: ${result.points.length - failed.length}/${result.points.length} points passed.`);
 if (!result.ok) throw new RerError('agent_door_failed', `Agent door conformance failed: ${failed.join(', ')}.`, 1, { failures: failed, agentDoor: result });
 return { declared: true, ...result };
}

export async function verificationSponsors(root, verification) {
 const owner = verification.owner ?? {};
 if (verification.sponsors === undefined) return [{ ...await verificationOwner(root, owner), sub: randomUUID() }];
 const values = verification.sponsors;
 if (!Array.isArray(values) || !values.length || values.length > 16) throw new RerError('agent_sponsors_invalid', 'verification.sponsors must contain one to sixteen labelled principals.', 1);
 const labels = new Set(), emails = new Set(), result = [];
 for (const [index, value] of values.entries()) {
  if (!value || typeof value !== 'object' || typeof value.label !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.label) || labels.has(value.label)) throw new RerError('agent_sponsors_invalid', 'Every verification sponsor needs a unique stable label.', 1);
  const { label, role = 'member', ...declaration } = value;
  if (!['admin', 'member'].includes(role)) throw new RerError('agent_sponsors_invalid', 'Additional sponsor roles must be admin or member.', 1);
  const native = await verificationOwner(root, { ...(index === 0 ? owner : {}), ...declaration });
  if (emails.has(native.email) || index > 0 && !native.initialize) throw new RerError('agent_sponsors_invalid', 'Additional verification sponsors need distinct emails and a native lifecycle initializer.', 1);
  labels.add(label); emails.add(native.email);
  result.push({ ...native, label, role, sub: randomUUID() });
 }
 return result;
}
