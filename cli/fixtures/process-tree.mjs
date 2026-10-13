import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename} from 'node:path';
import {processInfo} from '../../modules/job-queue/processes.mjs';
const execute=promisify(execFile);
function cpu(value){const parts=value.split(/[-:]/).map(Number);let seconds=parts.pop()+60*(parts.pop()??0)+3600*(parts.pop()??0)+86400*(parts.pop()??0);return seconds;}
export async function processTree(root){
 const {stdout}=await execute('/bin/ps',['-A','-o','pid=','-o','ppid=','-o','rss=','-o','time=','-o','comm=']);
 const rows=stdout.trim().split('\n').flatMap(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),rssKiB:Number(match[3]),cpuSeconds:cpu(match[4]),executable:basename(match[5])}]:[];});
 const owned=new Set([root]);let size;
 do{size=owned.size;for(const row of rows)if(owned.has(row.parent))owned.add(row.pid);}while(owned.size!==size);
 const tree=rows.filter(row=>owned.has(row.pid));
 for(const row of tree){const info=await processInfo(row.pid);row.start=info?.start;row.vite=Boolean(info?.title&&/(?:\/vite(?:\/|\s)|vite\.js)/.test(info.title));}
 return tree;
}

// Check recorded lifetimes after parent exit too: descendants may reparent.
export async function remainingProcesses(snapshot) {
 const live=[];
 for(const prior of snapshot){const current=await processInfo(prior.pid);if(current&&current.start===prior.start)live.push(prior);}
 return live;
}
