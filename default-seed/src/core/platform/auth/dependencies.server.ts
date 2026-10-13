import { createDependencies } from '../../../../../modules/dependencies/index.mjs'
import { createIdpOwnerClaimHandler } from '../../../../../modules/owner-claim/index.mjs'
import { operatorAuth } from './session.server'
import { authConfig } from './config.server'
import { theme } from '../../app/theme'
import type { Bindings } from '../bindings.server'
export async function dependenciesResponse(request: Request, env: Bindings) {
 const claimOwner=(token:string)=>createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:()=>request.headers.get('CF-Connecting-IP')??''})(new Request(env.AUTH_ORIGIN+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(env.AUTH_ORIGIN).host,Origin:env.AUTH_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({token})}))
 const options = { db: env.DB, origin: env.AUTH_ORIGIN, name: theme.productName, provider: env.IDENTITY_PROVIDER, local: env.AUTH_LOCAL === 'true', auth: operatorAuth(env), claimOwner }
 const response = await createDependencies(options).handle(request)
 if (response) return response
 return createIdpOwnerClaimHandler({ db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '' })(request)
}
