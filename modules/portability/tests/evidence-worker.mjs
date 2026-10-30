import evidence from 'virtual:rer-legacy-migration-evidence';
import { createPortabilityHandler } from '../index.mjs';
import { workerMigrations } from '../worker-history.mjs';
const policy={product:'synthetic-evidence',excludeTables:['settings']};
let handler;
export default {async fetch(request,env) {
 handler??=await createPortabilityHandler({db:env.DB,policy,migrations:()=>workerMigrations(env.DB,policy,evidence),
  appOrigin:'https://evidence.test',authorize:()=> 'fixture-owner'});
 return handler(request);
}};
