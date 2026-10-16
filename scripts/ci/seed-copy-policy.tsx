import { normalizeEmail, emailDomain, safeReturnTo } from '../../modules/operator-auth/policy.mjs';
import * as seedPolicy from '../../default-seed/scripts/base-cli/modules/operator-auth/policy.mjs';

// Exercise the client-safe import a seed's sign-in route uses, in both copies.
export function signInValues(emailInput: unknown, returnTo: unknown): string[] {
  const email = normalizeEmail(emailInput);
  const seedEmail = seedPolicy.normalizeEmail(emailInput);
  return [email, emailDomain(email), safeReturnTo(returnTo), safeReturnTo(returnTo, '/app'),
    seedEmail, seedPolicy.emailDomain(seedEmail), seedPolicy.safeReturnTo(returnTo), seedPolicy.safeReturnTo(returnTo, '/app')];
}
