import {readFile, writeFile, readdir, rm, chmod, mkdir, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {installationLock} from '../../edition-authoring/lock.mjs';
import {MANAGED_WORKFLOW, repositoryAutomation, dispatchOnlyWorkflow} from './automation.mjs';
import {droppedCopyBlobs, installationMetadata} from './metadata.mjs';
import {managedWorkflow} from './workflow.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
export async function projectInstallation(root, entries, {repository, ref, sourceCommit, workflowRef, artifactFile}) {
 const sources = new Map(), ids = new Map(entries.map(entry => [entry.path, entry.id]));
 for (const {path} of entries) if (path.endsWith('.json') || path === MANAGED_WORKFLOW) sources.set(path, await readFile(join(root,path)));
 const kept = sources.has(MANAGED_WORKFLOW) && dispatchOnlyWorkflow(sources.get(MANAGED_WORKFLOW));
 if (!kept && !workflowRef) throw Error('Provide --workflow-ref OWNER/REPO/.github/workflows/FILE.yml@SHA: the seed has no dispatch-only managed workflow.');
 const workflow = kept ? sources.get(MANAGED_WORKFLOW) : managedWorkflow(workflowRef, artifactFile);
 const dropped = droppedCopyBlobs(sources.values(), path => ids.get(path), kept), changed = {};
 const replace = async (path, bytes, executable = false) => {
  await mkdir(dirname(join(root,path)), {recursive:true});
  await writeFile(join(root,path), bytes); await chmod(join(root,path), executable ? 0o755 : 0o644);
  changed[path] = {data: Buffer.from(bytes).toString('base64'), executable};
 };
 for (const {path} of entries) if (repositoryAutomation(path)) await rm(join(root,path), {force:true});
 let recipe;
 for (const [path,bytes] of sources) {
  if (repositoryAutomation(path) || path === 'sources.lock.json') continue;
  const body = installationMetadata(path, bytes, kept, dropped);
  if (body) {
   await replace(path, body, entries.find(entry => entry.path === path).mode === '100755');
   if (path === 'edition.json') recipe = JSON.parse(Buffer.from(body).toString('utf8'));
  }
 }
 await replace(MANAGED_WORKFLOW, workflow, kept && entries.find(entry => entry.path === MANAGED_WORKFLOW).mode === '100755');
 await replace('rer-upstream.json', json({schema:1, repository, tag:ref, commit:sourceCommit}));
 if (sources.has('sources.lock.json')) await writeFile(join(root,'sources.lock.json'),json(installationLock(JSON.parse(sources.get('sources.lock.json')), {removed:repositoryAutomation, changed, recipe})));
}

// Archive attributes may omit/substitute bytes. Restore those from local Git objects,
// just as the platform verifies its downloaded archive against the exact source tree.
export async function restoreArchive(root, entries, readBlob) {
 const names = new Set(entries.map(entry => entry.path));
 async function prune(directory, prefix = '') {
  for (const item of await readdir(directory, {withFileTypes:true})) {
   const name = prefix + item.name, path = join(directory,item.name);
   if (item.isDirectory()) { await prune(path,name+'/'); continue; }
   if (!names.has(name)) await rm(path,{force:true});
  }
 }
 await prune(root);
 for (const entry of entries) {
  if (!['100644','100755'].includes(entry.mode)) throw Error(`Unsupported source mode: ${entry.path}`);
  const path = join(root,entry.path), stat = await lstat(path).catch(() => null);
  const bytes = stat?.isFile() ? await readFile(path) : null;
  const id = bytes && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (id !== entry.id) {
   if (stat) await rm(path,{force:true,recursive:true});
   await mkdir(dirname(path),{recursive:true});await writeFile(path,await readBlob(entry.id));
  }
  await chmod(path,entry.mode === '100755' ? 0o755 : 0o644);
 }
}
