import {createWriteStream} from 'node:fs';
import {productionPlan,serializePlan} from './production-options.mjs';

// Short-lived: resolves the Worker's Miniflare options with Wrangler and writes
// them as JSON to fd 3, a pipe only the starting runtime reads. The plan holds
// private settings, so it is never written to a file or an argument.
if(process.env.RER_ORIGIN_KEY && !/^[A-Z][A-Z0-9_]*$/.test(process.env.RER_ORIGIN_KEY))throw Error('Invalid local origin setting name');
const plan=await productionPlan(process.cwd(),process.env.RER_DEV_ORIGIN,Number(process.env.RER_RUNTIME_PORT),process.env.RER_RUNTIME_HOST);
const output=createWriteStream(null,{fd:3});
await new Promise((done,fail)=>{output.once('error',fail);output.end(serializePlan(plan),done);});
