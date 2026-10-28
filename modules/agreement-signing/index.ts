import { requireThat } from './errors.ts';
import { Store } from './store.ts';
import { prepare, issue, close, recordExternal } from './requests.ts';
import { review, sign } from './participants.ts';
import { evidence, restore } from './evidence.ts';
import { verify } from './verification.ts';
import type { SigningOptions, SigningService } from './types.ts';
export type * from './types.ts';
export { SigningError } from './errors.ts';
export { artifactRef, canonical, limits, sha256 } from './encoding.ts';
export function createSigningService(options: SigningOptions): SigningService {
  requireThat(options.invitations === 'capability' || options.invitations === 'native-session');
  requireThat(options.credentialKey?.algorithm.name === 'AES-GCM' && options.credentialKey.usages.includes('encrypt') && options.credentialKey.usages.includes('decrypt'));
  requireThat(typeof options.sourceGuard === 'function' && typeof options.participantGuard === 'function' && typeof options.nativeCommit === 'function');
  requireThat(typeof options.artifacts?.read === 'function' && typeof options.artifacts?.put === 'function');
  const store = new Store(options);
  return {
    prepare: (ctx, input) => prepare(store, ctx, input), issue: (ctx, input) => issue(store, ctx, input),
    review: (ctx, input) => review(store, ctx, input), sign: (ctx, input) => sign(store, ctx, input),
    close: (ctx, input) => close(store, ctx, input), recordExternal: (ctx, input) => recordExternal(store, ctx, input),
    evidence: (ctx, id) => evidence(store, ctx, id), verify,
    restore: (ctx, input) => restore(store, ctx, input),
  };
}
