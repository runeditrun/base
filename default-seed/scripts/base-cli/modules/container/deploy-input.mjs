import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refuseLocalModels } from '../deploy-kit/local-only.mjs';
import { localOnlyBinding } from '../deploy-kit/owner.mjs';
import { readDeployEnvFile } from '../deploy-kit/env-file.mjs';
export async function deployInputs({root,envFile,localOnlyKeys=[]}) {
 await refuseLocalModels(root);
 const declaration=JSON.parse(await readFile(join(root,'deploy.json'),'utf8'));
 if(localOnlyBinding(declaration,localOnlyKeys))throw new Error('Deploy declaration contains a local-only binding');
 if(!envFile)throw new Error('Container deploy requires --env-file with private production settings');
 const settings=await readDeployEnvFile(root,envFile,localOnlyKeys);
 return{declaration,settings,encoded:Object.entries(settings).map(([key,value])=>key+'='+value).join('\n')+'\n'};
}
