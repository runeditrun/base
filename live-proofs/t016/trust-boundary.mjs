import { digest, insist } from '../../scripts/qualification/operations.mjs';
export function isolationAttestation(images, controllerSha) {
  insist(/^[a-f0-9]{40}$/.test(controllerSha ?? ''), 'isolation-unqualified');
  return digest({ version: 1, controllerSha, images });
}
export function requireIsolation(env, images) {
  insist(process.platform === 'linux' && env.T016_ISOLATION_ATTESTATION === isolationAttestation(images, env.CONTROL_SHA), 'isolation-unqualified');
}
