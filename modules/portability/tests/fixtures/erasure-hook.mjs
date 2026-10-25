// Synthetic seed semantics. Production seeds declare their own policy module.
export const ddl=[
  'CREATE TABLE accounts(id TEXT PRIMARY KEY,state TEXT NOT NULL)',
  'CREATE TABLE credentials(id TEXT PRIMARY KEY,account TEXT REFERENCES accounts(id),kind TEXT NOT NULL,value TEXT)',
  'CREATE TABLE delegations(id TEXT PRIMARY KEY,issuer TEXT REFERENCES accounts(id),holder TEXT REFERENCES accounts(id))',
  'CREATE TABLE erased_accounts(id TEXT PRIMARY KEY)',
];
export const policy={product:'erasure-fixture',restoreHook:{
  registry:{table:'erased_accounts',idColumn:'id'},
  async run({stagedDb,liveDb,archiveManifest}) {
    if(archiveManifest.product!=='erasure-fixture')throw Error('wrong fixture');
    for(const id of liveDb.erasedIds()) {
      const accounts=await stagedDb.read('accounts');
      if(!accounts.some(row=>row.id===id))continue;
      const revocations={};
      for(const kind of ['password','session','api_key','passkey','oauth_token','refresh_token'])
        revocations[kind]=await stagedDb.delete('credentials',{account:id,kind});
      // Partition self-delegations so each physical row is removed once.
      const delegations=await stagedDb.read('delegations');
      revocations.delegation_issued=0;revocations.delegation_held=0;
      for(const row of delegations)if(row.issuer===id || row.holder===id) {
        const n=await stagedDb.delete('delegations',{id:row.id});
        if(row.issuer===id)revocations.delegation_issued+=n;
        else revocations.delegation_held+=n;
      }
      await stagedDb.update('accounts',{id},{state:'erased'});
      liveDb.audit({opaqueId:id,revocations});
    }
  },
}};
export async function seed(db) {
  await db.batch([
    db.prepare("INSERT INTO accounts VALUES('opaque-erased','active'),('opaque-live','active')"),
    ...['password','session','api_key','passkey','oauth_token','refresh_token'].map(kind=>db.prepare(
      'INSERT INTO credentials VALUES(?,?,?,?)').bind('fixture-'+kind,'opaque-erased',kind,'fixture-value')),
    db.prepare("INSERT INTO credentials VALUES('fixture-survivor','opaque-live','session','fixture-value')"),
    db.prepare("INSERT INTO delegations VALUES('issued','opaque-erased','opaque-live'),('held','opaque-live','opaque-erased')"),
  ]);
}
