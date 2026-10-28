import { RerError } from './errors.mjs';

// Approve only known ownership failures; arbitrary provider error text stays
// behind the usual redacted capture boundary.
export function demoDeployFailure(error, store) {
 const codes = ['resource-name-collision', 'owned-resource-replaced', 'resource-not-in-record', 'uncertain-resource-create'];
 if (!codes.includes(error.message)) return error;
 const resource = typeof error.resource === 'string' && /^[a-z-]+:[a-z0-9.-]+$/.test(error.resource) ? ` ${error.resource}` : '';
 const reason = error.ownershipReason === 'missing-annotation'
  ? ': served version has no workers/message ownership annotation; unchanged secret-only history matching the previous rer deployment record could not be verified'
  : error.ownershipReason === 'different-annotation' ? ': served version workers/message ownership annotation does not match this demo' : '';
 const recovery = 'Nothing was changed. For your own demo, restore the verified previous rer deployment and its workers/message ownership annotation, then rerun the same command. For a foreign resource, choose another --environment name or remove it yourself.';
 return new RerError('deploy_refused', store.redact(`Demo deploy refused: ${error.message}${resource}${reason}. ${recovery}`), 1);
}
