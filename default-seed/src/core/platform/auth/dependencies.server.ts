import { createDependencies } from '../../../../../modules/dependencies/index.mjs'
import { createIdpOwnerClaimHandler, createOwnerClaimHandler } from '../../../../../modules/owner-claim/index.mjs'
import { operatorAuth } from './session.server'
import { authConfig } from './config.server'
import { theme } from '../../app/theme'
import type { Bindings } from '../bindings.server'
export async function dependenciesResponse(request: Request, env: Bindings) {
 // A signed owner claim (a hosted demo's front, RER Managed) when its keys are configured; a missing part fails closed.
 if (env.RER_OWNER_CLAIM_PUBLIC_KEYS) {
  const signed = await createOwnerClaimHandler({ db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '', issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '', appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) })(request)
  if (signed) return signed
 }
 const claimOwner=(token:string)=>createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:()=>request.headers.get('CF-Connecting-IP')??''})(new Request(env.AUTH_ORIGIN+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(env.AUTH_ORIGIN).host,Origin:env.AUTH_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({token})}))
 const options = { db: env.DB, INSTALLATION_KEY: env.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: env.INSTALLATION_KEY_PREVIOUS, origin: env.AUTH_ORIGIN, name: theme.productName, provider: env.IDENTITY_PROVIDER, local: env.AUTH_LOCAL === 'true', auth: operatorAuth(env), claimOwner }
 const response = await createDependencies(options).handle(request)
 if (response) return response
 return createIdpOwnerClaimHandler({ db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '' })(request)
}
