import {setTimeout as pause} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
const iterations = 2000, delayMs = 5;
const wall = [], monotonic = [];
for (let i=0; i<iterations; i++) {
 const date = Date.now(), high = performance.now();
 await pause(delayMs);
 monotonic.push(performance.now()-high);
 wall.push(Date.now()-date);
}
console.log(JSON.stringify({node:process.version,iterations,delayMs,
 wall:{early:wall.filter(ms=>ms<delayMs).length,minMs:Math.min(...wall),maxMs:Math.max(...wall)},
 monotonic:{early:monotonic.filter(ms=>ms<delayMs).length,minMs:Math.min(...monotonic),maxMs:Math.max(...monotonic)},
 examples:wall.flatMap((ms,i)=>ms<delayMs?[{iteration:i,wallMs:ms,monotonicMs:monotonic[i]}]:[]).slice(0,10)},null,2));
