import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {collectMigrations, sourcePath} from '../delivery-producer/migrations.mjs';

// These are the producer's source policy and exported policy locations. Never
// infer extra directories from a seed name or scan undeclared SQL trees.
const packagingFiles = ['packaging.json','rer-packaging.json','scripts/delivery/base/packaging.json'];
async function migrationPolicy(root) {
 const policies = [];
 for (const candidate of packagingFiles) {
  const file = await sourcePath(root,candidate,{optional:true});
  if (!file) continue;
  const packaging = JSON.parse(await readFile(file,'utf8'));
  const inputs = packaging.artifact?.specInputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Invalid demo migration packaging policy');
  policies.push({migrationPrefix:inputs.migrationPrefix === undefined ? '' : inputs.migrationPrefix,extraMigrationDirectories:inputs.extraMigrationDirectories === undefined ? [] : inputs.extraMigrationDirectories,...(inputs.wranglerFile === undefined ? {} : {wranglerFile:inputs.wranglerFile})});
 }
 if (policies.some(policy => !isDeepStrictEqual(policy,policies[0]))) throw new Error('Conflicting demo migration packaging policies');
 return policies[0] ?? {migrationPrefix:'',extraMigrationDirectories:[]};
}

export async function demoMigrationInventory(root,{config,configFile}) {
 const policy = await migrationPolicy(root);
 const file = await sourcePath(root,policy.wranglerFile ?? configFile);
 const migrationConfig = policy.wranglerFile === undefined ? config : JSON.parse(await readFile(file,'utf8'));
 const resources = (config.d1_databases ?? []).map(db => ({kind:'d1',binding:db.binding}));
 const directories = (migrationConfig.d1_databases ?? []).map(db => {
  if (typeof db.migrations_dir !== 'string' || !db.migrations_dir.trim()) throw new Error('Invalid D1 migrations_dir');
  return {binding:db.binding,path:resolve(dirname(file),db.migrations_dir),prefix:policy.migrationPrefix};
 });
 return collectMigrations(root,[...directories,...policy.extraMigrationDirectories],resources);
}
