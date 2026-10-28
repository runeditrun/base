import type { Principal, Runtime } from './types.ts'

/** A current native grant may remove authenticated scopes, never add them. */
export async function narrowPrincipal(rt: Runtime, principal: Principal): Promise<Principal> {
  if (!rt.options.grantedScopes) return principal
  const granted = await rt.options.grantedScopes(principal)
  if (!Array.isArray(granted) || granted.some(scope => typeof scope !== 'string')) throw new TypeError('Invalid native grant')
  return { ...principal, scopes: principal.scopes.filter(scope => granted.includes(scope)) }
}
