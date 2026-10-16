import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { collectBuildModules } from '../../deploy-kit/build-modules.mjs';
import { moduleType } from '../../deploy-kit/artifact.mjs';
import { validateMigrations } from '../../deploy-kit/migrations.mjs';
import { createLedger, ledger, literal } from '../../deploy-kit/migration-ledger.mjs';
import { checkImageVariables } from '../../container/image-variables.mjs';
import { containerMigrationInventory } from '../../container/migration-inventory.mjs';

// The same production build-module and migration inventory as Base's deploy kit.
// Packaging occurs once per host deploy, never during a visitor's start.
export async function prepareNativeDemo(root,folder,app) {
 const directory=join(root,'dist/server'),config=JSON.parse(await readFile(join(directory,'wrangler.json'),'utf8'));
 if ((config.durable_objects?.bindings?.length??0)||(config.queues?.producers?.length??0)||(config.kv_namespaces?.length??0)||(config.services?.length??0)) throw new Error('native-demo-supports-d1-r2-only');
 await checkImageVariables(root,config.vars??{},app.secrets??[]);
 const main=relative(directory,resolve(directory,config.main));
 const modules=await collectBuildModules(directory,config,main);
 const inventory=await containerMigrationInventory(root,{config,configFile:'dist/server/wrangler.json'});
 const migrations={};
 for (const db of config.d1_databases??[]) {
  const rows=inventory.filter(row=>row.binding===db.binding);validateMigrations(rows);
  migrations[db.binding]=createLedger+';\n'+rows.map(row=>row.sql+'\n;\n'+`INSERT INTO ${ledger}(name,sha256,state) VALUES (${literal(row.name)},${literal(row.sha256)},'applied');`).join('\n');
 }
 const ingress=await readFile(new URL('./ingress.mjs',import.meta.url));
 modules.push({path:'__rer_native_ingress.mjs',base64:ingress.toString('base64')});
 modules.push({path:'__rer_native_entry.mjs',base64:Buffer.from(`import app from ${JSON.stringify('./'+main)};\nimport {nativeIngress} from './__rer_native_ingress.mjs';\nexport default nativeIngress(app);\n`).toString('base64')});
 if (modules.some(file=>!moduleType(file.path))) throw new Error('native-unsupported-module');
 await mkdir(folder,{recursive:true});
 await cp(join(root,'dist/client'),join(folder,'assets'),{recursive:true});
 await mkdir(join(folder,'assets/__rer_native'),{recursive:true});
 const bundle={main:'__rer_native_entry.mjs',modules,migrations,d1:app.d1??[],r2:app.r2??[],crons:app.crons??[],vars:config.vars??{},compatibilityDate:app.compatibilityDate,compatibilityFlags:app.compatibilityFlags??[]};
 await writeFile(join(folder,'assets/__rer_native/bundle.json'),JSON.stringify(bundle));
 return bundle;
}
