import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import timers from 'node:timers/promises';

// The host load and passing time are synthetic. The CLI still makes its own
// admission decisions and, if admitted, starts the real application.
const mode=process.env.RER_TEST_SERVING_LOAD;
const delay=timers.setTimeout,now=performance.now.bind(performance);
let elapsed=0;
function load(){return mode==='clears'&&elapsed>=25_000?0:30;}
os.loadavg=()=>[load(),0,0];
performance.now=()=>now()+elapsed;
timers.setTimeout=(ms,value,options)=>{
 if(mode==='cancel'||!load()||!options?.signal||ms<=250||ms>2500)return delay(ms,value,options);
 return delay(1,value,options).then(result=>{elapsed+=ms;return result;});
};
syncBuiltinESMExports();
