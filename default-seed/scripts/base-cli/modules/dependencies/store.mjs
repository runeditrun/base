import { keyPair } from './crypto.mjs';
import { requireInstallationKey, sealDependencyKey, openDependencyKey } from './sealing.mjs';

// Upgrade/rotation decrypts every row before changing any, then commits all
// replacements in one D1 batch. CAS preserves unlink/replacement races.
export async function resealDependencyKeys(db, config = {}) {
 requireInstallationKey(config);
 const rows = (await db.prepare('SELECT interface,private_key FROM rer_dependency_keys').all()).results;
 const updates = [];
 for (const row of rows) {
  const value = await openDependencyKey(config, row.interface, row.private_key);
  if (value.reseal) updates.push(db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=? AND private_key=?').bind(await sealDependencyKey(config, row.interface, value.key), row.interface, row.private_key));
 }
 if (updates.length) await db.batch(updates);
 // A successful return authorizes retirement of the previous secret. Check the
// complete current set, including rows changed concurrently with the snapshot.
 for (const row of (await db.prepare('SELECT interface,private_key FROM rer_dependency_keys').all()).results) await openDependencyKey(config, row.interface, row.private_key, { currentOnly: true });
 return { resealed: updates.length };
}
export function dependencyStore(db, config = {}) {
 const first=(sql,...args)=>db.prepare(sql).bind(...args).first();
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 async function readKey(contract = 'oidc-provider@1') {
  await resealDependencyKeys(db, config);
  const row = await first('SELECT private_key FROM rer_dependency_keys WHERE interface=?',contract);
  return row ? { key: (await openDependencyKey(config, contract, row.private_key, { currentOnly: true })).key, sealedKey: row.private_key } : null;
 }
 return {
  first,run,readKey,
  async installation(contract = 'oidc-provider@1') {
   requireInstallationKey(config);
   await run('INSERT INTO rer_dependency_installation(singleton,sector_id) VALUES(1,?) ON CONFLICT DO NOTHING',crypto.randomUUID());
   const row=await first('SELECT * FROM rer_dependency_installation WHERE singleton=1');
   if(!await first('SELECT 1 FROM rer_dependency_keys WHERE interface=?',contract)) {
    await run('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?) ON CONFLICT DO NOTHING',contract,await sealDependencyKey(config,contract,await keyPair()));
   }
   return {...row,...await readKey(contract)};
  },
  async link(contract = 'oidc-provider@1') { const row=await first("SELECT * FROM rer_dependency_link WHERE interface=?",contract);return row?{...row,metadata:JSON.parse(row.metadata)}:null; },
 };
}
