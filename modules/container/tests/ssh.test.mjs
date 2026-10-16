import test from 'node:test';
import assert from 'node:assert/strict';
import { host, image, fixture, docker, ssh, inspect, running, ownerLabels, currentPath, interruptStage } from './ssh-fixture.mjs';
import { quote } from '../ssh.mjs';
const enabled = Boolean(host && image);
const options = { skip: !enabled, timeout: 240000 };

test('public source and packaged SSH deploy isolate full identity and preserve their own data', options, async t => {
 const f = await fixture(t);
 const a = await f.select('owner-one/shared-seed', 'http://127.0.0.1:60571');
 const first = await f.cli(a);
 const aid = await running(a);
 await docker('exec', aid, 'sh', '-c', 'printf owner-one > /data/tenant-canary');
 const aVolume = (await inspect('container', aid)).Mounts.find(mount => mount.Destination === '/data').Name;
 const b = await f.select('owner-two/shared-seed', 'http://127.0.0.1:60572');
 const second = await f.cli(b, { packaged: true });
 assert.notEqual(first.result.installation, second.result.installation);
 assert.equal(await running(a), aid);
 assert.notEqual((await inspect('container', b.name + '-app')).Mounts.find(mount => mount.Destination === '/data').Name, aVolume);
 await assert.rejects(docker('exec', b.name + '-app', 'test', '-e', '/data/tenant-canary'));
 const bid = await running(b);
 await f.select('owner-one/shared-seed', a.origin);
 await f.cli(a, { packaged: true });
 assert.equal(await docker('exec', a.name + '-app', 'cat', '/data/tenant-canary'), 'owner-one');
 assert.equal(await running(b), bid);
 const separateEnv = await f.select('owner-one/shared-seed', 'http://127.0.0.1:60574', f.environment + '-two');
 await f.cli(separateEnv);
 assert.notEqual((await inspect('container', separateEnv.name + '-app')).Mounts.find(mount => mount.Destination === '/data').Name, aVolume);
 assert.equal(await running(b), bid);
 await ownerLabels(a); await ownerLabels(b);
 // The raw Docker env file must preserve dollar signs and quote bytes.
 const settings = (await inspect('container', a.name + '-app')).Config.Env;
 assert.ok(settings.includes('SESSION_SECRET=' + f.secret));
 // Delimiter ambiguity is exercised through public dry-run deployment output.
 const c = await f.select('owner/app-prod', 'http://127.0.0.1:60573', 'stage');
 const dryC = await f.cli(c, { extra: ['--dry-run'] });
 const d = await f.select('owner/app', 'http://127.0.0.1:60573', 'prod-stage');
 const dryD = await f.cli(d, { packaged: true, extra: ['--dry-run'] });
 assert.notEqual(dryC.result.installation, dryD.result.installation);
 await assert.rejects(ssh('test -e ' + quote(f.home + '/.rer-host/' + c.name)));
 await assert.rejects(ssh('test -e ' + quote(f.home + '/.rer-host/' + d.name)));
 t.diagnostic(JSON.stringify({flow:'namespace',differentInstallations:first.result.installation!==second.result.installation,otherContainerPreserved:await running(b)===bid,ownVolumeCanaryPreserved:await docker('exec',a.name+'-app','cat','/data/tenant-canary')==='owner-one',separateEnvironmentReady:Boolean(await running(separateEnv)),rawPrivateValuePreserved:settings.includes('SESSION_SECRET='+f.secret)}));
});

test('public SSH deploy refuses unsafe paths and Docker ownership before destructive work', options, async t => {
 const f = await fixture(t), a = await f.select('safety/owned-app', 'http://127.0.0.1:60573');
 await f.cli(a);
 const id = await running(a), directory = f.home + '/.rer-host/' + a.name, generation = await currentPath(a, f.home);
 const original = await ssh('sha256sum ' + quote(generation + '/settings.env'));
 // Canary lives outside the managed installation; public deployment cannot see
 // its secret-bearing target through a settings symlink.
 const outside = f.home + '/ssh-canary-' + f.environment;
 await ssh('printf preserved > ' + quote(outside) + '; chmod 644 ' + quote(outside));
 const checksum = await ssh('sha256sum ' + quote(outside));
 const safe = async () => { assert.equal(await running(a), id); assert.equal(await ssh('sha256sum ' + quote(outside)), checksum); assert.equal(await ssh('stat -c %a ' + quote(outside)), '644'); };
 try {
  await ssh('mv ' + quote(directory) + ' ' + quote(directory + '.saved') + '; ln -s ' + quote(directory + '.saved') + ' ' + quote(directory));
  try { await f.cli(a, { success: false }); await safe(); } finally { await ssh('rm ' + quote(directory) + '; mv ' + quote(directory + '.saved') + ' ' + quote(directory)); }
  for (const file of ['settings.env', 'compose.yaml', 'Caddyfile']) {
   await ssh('mv ' + quote(generation + '/' + file) + ' ' + quote(f.home + '/' + f.environment + '.saved') + '; ln -s ' + quote(outside) + ' ' + quote(generation + '/' + file));
   await f.cli(a, { success: false }); await safe();
   await ssh('rm ' + quote(generation + '/' + file) + '; mv ' + quote(f.home + '/' + f.environment + '.saved') + ' ' + quote(generation + '/' + file));
  }
  for (const alteration of ['chmod 666', 'chown 1234:1234']) {
   await ssh(alteration + ' ' + quote(generation + '/settings.env'));
   await f.cli(a, { success: false }); await safe();
   await ssh('chown 0:0 ' + quote(generation + '/settings.env') + '; chmod 600 ' + quote(generation + '/settings.env'));
  }
  await ssh('ln ' + quote(generation + '/settings.env') + ' ' + quote(f.home + '/' + f.environment + '.hardlink'));
  await f.cli(a, { success: false }); await safe();
  await ssh('rm ' + quote(f.home + '/' + f.environment + '.hardlink'));
  for (const path of [directory, f.home + '/.rer-host', f.home]) {
   const mode = await ssh('stat -c %a ' + quote(path));
   await ssh('chmod o+w ' + quote(path));
   try { await f.cli(a, { success: false }); await safe(); } finally { await ssh('chmod ' + mode + ' ' + quote(path)); }
  }
  assert.equal(await ssh('sha256sum ' + quote(generation + '/settings.env')), original);
  t.diagnostic(JSON.stringify({flow:'unsafe-paths',liveContainerPreserved:await running(a)===id,privateFilePreserved:await ssh('sha256sum '+quote(generation+'/settings.env'))===original,outsideCanaryPreserved:await ssh('sha256sum '+quote(outside))===checksum,outsideMode:await ssh('stat -c %a '+quote(outside))}));
  // Neither stored compose nor a labeled extra service may select another
  // tenant's container for shutdown. Unknown owned services are refused.
  const extra = a.name + '-unexpected';
  await docker('container', 'create', '--name', extra, '--mount', 'type=tmpfs,target=/data', '--label', 'io.runeditrun.installation=' + a.labels['io.runeditrun.installation'], image);
  try { await f.cli(a, { success: false }); await safe(); } finally { await docker('container', 'rm', extra); }
  const collision = await f.select('safety/foreign-volume', 'http://127.0.0.1:60574');
  await docker('volume', 'create', collision.name + '-data');
  try { await f.cli(collision, { success: false }); await safe(); } finally { await docker('volume', 'rm', collision.name + '-data'); }
  await docker('network', 'create', '--label', 'io.runeditrun.installation=' + collision.labels['io.runeditrun.installation'], '--label', 'io.runeditrun.project=other/owner', collision.name + '-ingress');
  try { await f.cli(collision, { success: false }); await safe(); } finally { await docker('network', 'rm', collision.name + '-ingress'); }
  await f.select('safety/owned-app', a.origin);
  const watcher=await interruptStage(directory);
  try { await f.cli(a,{success:false}); assert.match(await watcher.finished,/STAGE_INTERRUPTED/); } finally { watcher.stop(); }
  await safe();
  assert.equal(await currentPath(a,f.home),generation);
  t.diagnostic(JSON.stringify({flow:'interrupted-stage',liveContainerPreserved:await running(a)===id,committedGenerationPreserved:await currentPath(a,f.home)===generation}));
  // Holding a safe dirfd is insufficient if its absolute name is replaced
  // during staging. Both maintained entrypoints must refuse before shutdown.
  const substitute = f.home + '/ssh-substitute-' + f.environment;
  await ssh('mkdir -m 700 ' + quote(substitute));
  try {
   for (const packaged of [false, true]) {
    const swap = await interruptStage(directory, substitute);
    try {
     await f.cli(a, { packaged, success: false });
     assert.match(await swap.finished, /STAGE_PATH_REPLACED/);
     await safe();
     assert.equal((await inspect('container', id)).State.Running, true);
     assert.equal(await ssh('ls -A ' + quote(substitute)), '');
     t.diagnostic(JSON.stringify({flow:'path-replaced-after-stage',packaged,originalContainerRunning:true,outsideDirectoryUntouched:true}));
    } finally {
     swap.stop();
     await ssh('if test -L ' + quote(directory) + '; then rm ' + quote(directory) + '; mv ' + quote(directory + '.saved') + ' ' + quote(directory) + '; fi');
    }
   }
  } finally { await ssh('rmdir ' + quote(substitute)); }
  // Cleanup and commit must retain the exact staged, previous-generation and
  // current-manifest identities. A same-UID private directory or manifest from
  // another real install passes all ownership and permission checks, yet must
  // be neither deleted nor overwritten.
  const b = await f.select('safety/other-app', 'http://127.0.0.1:60574');
  await f.cli(b);
  const bid = await running(b), otherGeneration = await currentPath(b, f.home), otherManifest = f.home + '/.rer-host/' + b.name + '/current.json';
  const snapshot = path => ssh('if test -d ' + quote(path) + '; then cd ' + quote(path) + ' && stat -c ' + quote('%d:%i:%a:%u:%h') + ' . settings.env compose.yaml Caddyfile && sha256sum settings.env compose.yaml Caddyfile; else stat -c ' + quote('%d:%i:%a:%u:%h') + ' ' + quote(path) + ' && sha256sum < ' + quote(path) + '; fi');
  const others = { [otherGeneration]: await snapshot(otherGeneration), [otherManifest]: await snapshot(otherManifest) };
  await f.select('safety/owned-app', a.origin);
  for (const [target, other, kind] of [['stage', otherGeneration, 'stage'], [generation, otherGeneration, 'previous'], [directory + '/current.json', otherManifest, 'manifest']]) for (const packaged of [false, true]) {
   const saved = f.home + '/ssh-generation-saved-' + f.environment;
   const swap = await interruptStage(directory, other, { target, saved });
   let replaced;
   try {
    await f.cli(a, { packaged, success: false });
    const output = await swap.finished;
    replaced = output.match(/STAGE_GENERATION_REPLACED (.+)/)?.[1];
    assert.ok(replaced, output);
    await safe();
    assert.equal((await inspect('container', id)).State.Running, true);
    assert.equal(await running(b), bid);
    assert.equal((await inspect('container', bid)).State.Running, true);
    assert.equal(await snapshot(replaced), others[other]);
    t.diagnostic(JSON.stringify({flow:'transplanted-after-stage',target:kind,packaged,originalContainerRunning:true,otherContainerRunning:true,otherFilesAndIdentitiesPreserved:true}));
   } finally {
    swap.stop();
    // The watcher reports the destination even when a buggy deploy removes it.
    if (!replaced) replaced = (await swap.finished).match(/STAGE_GENERATION_REPLACED (.+)/)?.[1];
    if (replaced) await ssh('if test -e ' + quote(replaced) + '; then mv ' + quote(replaced) + ' ' + quote(other) + '; fi; mv ' + quote(saved) + ' ' + quote(replaced));
   }
   assert.equal(await snapshot(other), others[other]);
   assert.equal(await currentPath(a, f.home), generation);
  }
  // Mutating an owned regular compose file cannot execute a foreign deployment.
  await ssh('printf ' + quote('{"services":{"app":{"image":"missing.invalid/never","container_name":"unrelated"}}}') + ' > ' + quote(generation + '/compose.yaml'));
  // Complete and partial owned generations from an interrupted commit must
  // never execute; the next deploy replaces them with a complete generation.
  await ssh('mkdir -m 700 ' + quote(directory + '/stage-' + 'a'.repeat(32)) + '; printf interrupted > ' + quote(directory + '/stage-' + 'a'.repeat(32) + '/settings.env') + '; chmod 600 ' + quote(directory + '/stage-' + 'a'.repeat(32) + '/settings.env') + '; printf interrupted > ' + quote(directory + '/current-' + 'b'.repeat(32)) + '; chmod 600 ' + quote(directory + '/current-' + 'b'.repeat(32)));
  await f.cli(a, { packaged: true });
  assert.equal(await ssh('sha256sum ' + quote(outside)), checksum);
 } finally { await ssh('rm -f ' + quote(outside)); }
});
