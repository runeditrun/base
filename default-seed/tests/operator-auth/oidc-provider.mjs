import { provider, sign } from '../../../modules/operator-auth/identity/oidc/tests/idp.mjs'
import { parseIdToken, verifySignature } from '../../../modules/operator-auth/identity/oidc/jwt.mjs'

// Controlled Auth network edge; application code generates its private key.
export async function testProvider(origin, email) {
 const issuer='https://idp.example.test',codes=new Map()
 let redirectDiscovery=false,grantOwner=false
 const fake=await provider({issuer,alg:'ES256',clientId:'consumer',method:'private_key_jwt',redirectUri:origin+'/auth/oidc/auth/callback',rerInterfaces:['oidc-provider@1.0.0'],claims:{sub:'test-subject',email,email_verified_at:Math.floor(Date.now()/1000)-3600}})
 return {
  configuration:{IDENTITY_PROVIDER:issuer},issuer,
  allowOwnerClaim(){grantOwner=true},
  redirectDiscovery(){redirectDiscovery=true},
  async link(call,contract='oidc-provider@1'){
   const doc=await (await call('/.well-known/rer-dependencies')).json(),jwks=await (await call('/.well-known/rer-link/jwks/'+contract)).json()
   const code=crypto.randomUUID();codes.set(code,{doc,jwks,contract})
   return call('/.well-known/rer-link/callback',{method:'POST',input:{issuer,code,interface:contract}})
  },
  async grant(location,claims={}){const {code,state}=await fake.authorize(location,claims);return `/auth/oidc/auth/callback?state=${encodeURIComponent(state)}&code=${code}`},
  async fetch(request){
   if(request.url===issuer+'/.well-known/rer-provider')return Response.json({issuer,provides:['oidc-provider@1','error-sink@1'],version:1,initiate:issuer+'/link',redeem:issuer+'/redeem',deregister:issuer+'/remove'})
   if(request.url===issuer+'/redeem'){
    const data=await request.json(),grant=codes.get(data.code)
    if(!grant)return Response.json({error:'invalid_code'},{status:403})
    try {const jwt=parseIdToken(data.client_assertion,{algorithms:['ES256']});await verifySignature(jwt,grant.jwks);if(jwt.claims.code!==data.code||jwt.claims.aud!==request.url||jwt.claims.iss!==origin||data.callback!==grant.doc.callback)throw Error()}catch{return Response.json({error:'invalid_proof'},{status:403})}
    codes.delete(data.code);if(grant.contract==='oidc-provider@1')fake.options.clientKey=grant.jwks.keys[0]
    const now=Math.floor(Date.now()/1000),install_owner=grantOwner&&grant.doc.claim&&grant.contract==='oidc-provider@1'?await sign(fake.key,{iss:issuer,aud:'consumer',sub:'test-subject',iat:now,exp:now+300,jti:crypto.randomUUID(),email,email_verified:true,email_verified_at:now,install_owner:{client_id:'consumer',sector_id:grant.doc.sector_id,subject:'test-subject',email}}):undefined
    return Response.json({issuer,interface:grant.contract,origin,callback:grant.doc.callback,sector_id:grant.doc.sector_id,client_id:'consumer',continuity:'provider-owner',install_owner})
   }
   if(redirectDiscovery && request.url===issuer+'/.well-known/openid-configuration')return new Response(null,{status:302,headers:{location:'https://other.example.test/'}})
   return fake.fetch(request.url,{method:request.method,redirect:'manual',headers:Object.fromEntries(request.headers),...(request.method==='POST'?{body:await request.text()}:{})})
  },
 }
}
