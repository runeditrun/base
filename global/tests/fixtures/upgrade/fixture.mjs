// Two real maintained-reference releases and an isolated installation. These
// helpers also let evidence scripts alter releases, owner source and local D1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportReference } from '../../../../scripts/export-reference.mjs';
import { buildPackage } from '../../../../scripts/rer-package.mjs';
import { localD1 } from '../../../../cli/fixtures/local-d1.mjs';
import { isolatedQueue } from '../../../../cli/fixtures/queue.mjs';
import { run as execute, freePort } from '../../harness.mjs';
import { stopOwnedApp } from './owned-app.mjs';
import { releaseNetwork, repository, repositoryURL } from './releases.mjs';

const base = resolve(import.meta.dirname, '../../../..');
export const migration = 'migrations/core/0034_upgrade_details.sql';
export const ownerRow = { id: 'owner-record', body: 'Keep this customer record' };

export async function upgradeFixture(t, { keep = false, checkoutName = 'owner checkout' } = {}) {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-upgrade-')));
 const source = join(directory, 'publisher'), root = join(directory, checkoutName);
 const remote = join(directory, 'origin.git'), home = join(directory, 'home');
 await mkdir(home);
 const inherited = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP', 'COREPACK_HOME', 'npm_config_store_dir',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
 const env = await isolatedQueue(t, { ...inherited, HOME: home,
  PATH: dirname(process.execPath) + delimiter + process.env.PATH, CI: 'true',
  RER_NO_UPDATE_CHECK: '1', RER_NODE_AUTO: '0', WRANGLER_SEND_METRICS: 'false',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
  RER_DOOR_DIR: join(directory, 'door'), RER_SERVERS_DIR: join(directory, 'servers') });
 const command = async (program, args, cwd = directory) => {
  const result = await execute(program, args, { cwd, env });
  assert.equal(result.code, 0, `${program} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
 };
 const git = (cwd, ...args) => command('git', ['-c', 'user.name=Upgrade fixture', '-c', 'user.email=upgrade@example.test', ...args], cwd);
 const network = await releaseNetwork(directory, env, command);
 env.PATH = network.bin + delimiter + env.PATH;
 // Rewrite transport only. remote.origin.url remains the real GitHub identity.
 await writeFile(env.GIT_CONFIG_GLOBAL, `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = ${repositoryURL}\n[user]\n\tname = Upgrade fixture\n\temail = upgrade@example.test\n`);
 const children = new Set();
 const packaged = join(directory, 'rer'); await mkdir(packaged);
 await command('tar', ['-xzf', await buildPackage(base, join(directory, 'package')), '-C', packaged]);
 const rer = join(packaged, 'package/global/rer.mjs');
 const run = (args, options = {}) => execute(process.execPath, [rer, ...args], { cwd: root, env, detached: true, ...options });
 function start(args, options = {}) {
  const child = spawn(process.execPath, [rer, ...args], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child); child.stdoutText = ''; child.stderrText = '';
  child.stdout.on('data', bytes => { child.stdoutText += bytes; });
  child.stderr.on('data', bytes => { child.stderrText += bytes; });
  child.done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', code => { children.delete(child); resolveDone(code); }); });
  return child;
 }
 async function dispose() {
  await stopOwnedApp(env, root);
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(child => child.done));
  if (!keep) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
 }
 t.after(dispose);
 await exportReference(base, source);
 await appendFile(join(source, '.gitignore'), '\nnode_modules/\n.rer/\n');
 await writeFile(join(source, 'RELEASE.json'), JSON.stringify({ version: '1.0.0', min_rer_version: '0.1.0' }) + '\n');
 const operations = JSON.parse(await readFile(join(source, 'OPERATIONS.json'), 'utf8'));
 operations.project = repository;
 await writeFile(join(source, 'OPERATIONS.json'), JSON.stringify(operations, null, 2) + '\n');
 await writeFile(join(source, 'upstream-feature.txt'), 'First upstream release\n');
 await writeFile(join(source, 'migrations/core/0033_upgrade_records.sql'), 'CREATE TABLE upgrade_records (id TEXT PRIMARY KEY, body TEXT NOT NULL);\n');
 await git(source, 'init', '-q', '-b', 'main'); await git(source, 'add', '.');
 await git(source, 'commit', '-qm', 'First maintained reference release');
 const v1 = await network.publish(source, '1.0.0');
 await writeFile(join(source, 'RELEASE.json'), JSON.stringify({ version: '2.0.0', min_rer_version: '0.1.0' }) + '\n');
 await writeFile(join(source, 'upstream-feature.txt'), 'Second upstream release\n');
 await writeFile(join(source, migration), "ALTER TABLE upgrade_records ADD COLUMN edition TEXT NOT NULL DEFAULT 'upgraded';\n");
 await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Add reference data evolution');
 const v2 = await network.publish(source, '2.0.0');
 // Publisher main may record a newer release than the one being acquired.
 // That history is not an installed owner's baseline in a fresh clone.
 await git(source, 'commit', '--allow-empty', '-qm', 'Record current publisher release', '-m', `RER-Upstream-Release: ${repository}@${v2.commit}`);
 await git(directory, 'clone', '--bare', source, remote);
 const port = await freePort(), url = `http://127.0.0.1:${port}`;
 async function launch(release = v1.tag) {
  const result = await run(['dev', repositoryURL, '--release', release, '--anchors', network.anchors,
   '--dir', root, '--port', String(port), '--direct', '--json'], { cwd: directory });
  assert.equal(result.code, 0, 'Signed fixture launch failed; credential-bearing output withheld');
  return result;
 }
 async function ownerCommit(path = 'owner-customisation.md', contents = 'Owner instructions survive upstream updates.\n') {
  await writeFile(join(root, path), contents); await git(root, 'add', path);
  await git(root, 'commit', '-qm', 'Keep owner customisation');
  return { path, contents, commit: await git(root, 'rev-parse', 'HEAD') };
 }
 const sql = query => localD1(root, query);
 async function addRow() {
  await sql(`INSERT INTO upgrade_records (id, body) VALUES ('${ownerRow.id}', '${ownerRow.body}')`);
 }
 async function publish(version, edit, options) {
  if (edit) await edit(source);
  await writeFile(join(source, 'RELEASE.json'), JSON.stringify({ version, min_rer_version: '0.1.0' }) + '\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', `Fixture release ${version}`);
  const release = await network.publish(source, version, options);
  await git(source, 'push', remote, 'HEAD:refs/heads/main', '--tags');
  return release;
 }
 return { directory, source, root, remote, home, env, rer, git, command, run, start, dispose,
  v1, v2, releases: { v1, v2 }, anchors: network.anchors, network, port, url,
  launch, ownerCommit, sql, addRow, publish, repository, repositoryURL };
}
