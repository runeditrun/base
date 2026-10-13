import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
// Test data is explicit SETUP, including for server/process tests that need no
// application configuration. The optional NAME field keeps those starts empty.
export async function writeTestManifest(root, fields=[{name:'NAME',label:'Name',kind:'text'}]) {
 await writeFile(join(root,'rer-setup.json'),JSON.stringify({schema:1,title:'Test setup',groups:[],fields,steps:[{type:'extension',id:'fixture'}]},null,2)+'\n');
}
export function manifestContract(seed) {
 const {model,validateInput,...contract}=seed;
 return {...contract,setup:{manifestFile:'rer-setup.json'}};
}
