// Template adoption is a separate, narrow ownership decision: only tracked
// copies of known template bytes qualify. Helpers use the ordinary refresh
// preflight and share the workflow's all-or-nothing write plan.
import fs from 'node:fs';
import path from 'node:path';
import {raw, safe, noLinks} from './files.mjs';

const inside = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const mapped = (source, copy) => copy.path + source.slice(copy.originPath.length);
const templates = [
  ['.github/workflows/verify.yml', ['export/verify.yml', 'default-seed/.github/workflows/verify.yml']],
  ['.github/workflows/verify-nightly.yml', ['export/verify-nightly.yml', 'default-seed/.github/workflows/verify-nightly.yml']],
  ['VERIFY-WORKFLOW.md', ['export/VERIFY-WORKFLOW.md', 'default-seed/VERIFY-WORKFLOW.md']],
];
const tracked = root => new Set(raw(root, 'ls-files', '-z').toString('utf8').split('\0').filter(Boolean));

function include(plans, target, source, entry, revision) {
  let plan = plans.find(plan => inside(target, plan.copy.path));
  if (plan && mapped(source, plan.copy) !== target) throw Error(`Workflow dependency ${target} conflicts with its Base copy mapping`);
  if (plan?.removed.includes(target)) throw Error(`Workflow dependency ${target} was removed locally but is still invoked; restore it before refresh-base; no files were refreshed.`);
  if (!plan) {
    if (plans.some(plan => inside(plan.copy.path, target))) throw Error(`Workflow dependency ${target} overlaps an existing Base copy`);
    plan = {copy: {path: target, originPath: source, revision, files: {}, modes: {}}, sources: [], removed: []};
    plans.push(plan);
  }
  if (!plan.sources.some(([name]) => name === source)) plan.sources.push([source, entry]);
}

export function adoptWorkflowTemplates(root, plans, {tree, read, revision, files}) {
  const index = tracked(root), templateAdoptions = [], notices = [];
  for (const [target, historySources] of templates) {
    const [source] = historySources;
    if (!tree.has(source)) continue;
    const owner = plans.find(plan => inside(target, plan.copy.path));
    if (owner && !owner.copy.adapted?.[target]) continue;
    let file = files.get(target);
    if (!file) {
      noLinks(root, target);
      try { file = {regular: fs.lstatSync(path.join(root, target)).isFile()}; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!file?.regular) continue;
    noLinks(root, target);
    let match;
    if (!owner && index.has(target)) {
      const bytes = file.read();
      // Full committed history includes the published 0.2.83 runner.temp
      // template as well as earlier default-seed mirrors. No release pins or
      // guessed structural equality can transfer a seed's ownership.
      match = historySources.flatMap(name => read.history(revision, name))
        .find(entry => read.blobs([entry.object]).get(entry.object).equals(bytes));
    }
    if (match) {
      include(plans, target, source, tree.get(source), revision);
      templateAdoptions.push({path: target, originPath: source, from: match.revision});
    } else if (target.endsWith('.yml')) {
      notices.push(`${target}: preserved seed-owned workflow. The current template pins Ubuntu 24.04 and moves browser and apt caches to the runner temporary directory. To adopt, merge export/${path.posix.basename(source)} from Base ${revision} into ${target}, then run node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base ${target} ${source} ${revision} --base <base-checkout> and repeat rer refresh-base --ref ${revision} --base <base-checkout>.`);
    }
  }
  return {templateAdoptions, notices};
}

// Read run scalars/blocks, rather than all YAML text (cache paths and comments
// are not invoked scripts). Literal local reusable workflows are dependencies
// too. Recognize interpreter arguments and direct local commands, including
// commands nested in $(...) and env/sudo wrappers; echo/cache arguments do not
// acquire ownership merely because they look like script names.
function invocations(text) {
  const names = new Set();
  let blockIndent = null;
  for (const line of text.split('\n')) {
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    const run = /^\s*(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (blockIndent !== null && indent <= blockIndent) blockIndent = null;
    let command = blockIndent !== null ? line : '';
    if (run) {
      if (/^[|>][-+]?\s*(?:#.*)?$/.test(run[1])) blockIndent = line.indexOf('run:');
      else command = run[1];
    }
    const uses = /^\s*(?:-\s*)?uses:\s*['"]?\.\/(\S+?)['"]?\s*$/.exec(line);
    if (uses) names.add(uses[1]);
    if (/^(['"])[\s\S]*\1$/.test(command)) command = command.slice(1, -1);
    command += [...command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map(match => ';' + (match[1] ?? match[2])).join('');
    const tokens = [...command.matchAll(/#[^\n]*|'(?:[^']*)'|"(?:\\.|[^"\\])*"|[\w./=:+-]+|[^\s]/g)].map(match => match[0]);
    const word = token => /^(['"])[\s\S]*\1$/.test(token || '') ? token.slice(1, -1) : token;
    let expectingCommand = true;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('#')) break;
      if ([';', '|', '&', '('].includes(token)) { expectingCommand = true; continue; }
      if (!expectingCommand) continue;
      if (['sudo', 'env', 'exec', 'command'].includes(token) || token.startsWith('-') || /^\w+=/.test(word(token))) continue;
      expectingCommand = false;
      if (/^(?:node|python[\d.]*|bash|sh|deno|bun)$/.test(token)) {
        let j = i + 1;
        while (tokens[j]?.startsWith('-')) j++;
        const script = word(tokens[j]);
        if (/^(?:\.\/)?(?:[\w.-]+\/)+[\w.-]+$/.test(script || '')) names.add(script.replace(/^\.\//, ''));
      } else if (/^(?:\.\/)?(?:[\w.-]+\/)+[\w.-]+$/.test(token)) names.add(token.replace(/^\.\//, ''));
    }
  }
  return [...names].map(safe);
}

export function completeWorkflowHelpers(root, plans, {tree, read, revision}) {
  const index = tracked(root);
  const queue = plans.flatMap(plan => plan.sources.filter(([source]) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(mapped(source, plan.copy)))
    .map(([source, entry]) => ({source, entry, target: mapped(source, plan.copy)})));
  const seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const {source, entry, target} = queue[i];
    if (seen.has(target)) continue;
    seen.add(target);
    const sourceRoot = source.startsWith('default-seed/') ? 'default-seed/' : '';
    const destinationRoot = target.includes('.github/workflows/') ? target.slice(0, target.indexOf('.github/workflows/')) : '';
    const text = read.blobs([entry.object]).get(entry.object).toString('utf8');
    for (const invoked of invocations(text)) {
      const destination = safe(destinationRoot + invoked);
      noLinks(root, destination);
      const owner = plans.find(plan => inside(destination, plan.copy.path));
      if (owner?.removed.includes(destination)) throw Error(`Workflow dependency ${destination} was removed locally but is still invoked; restore it before refresh-base; no files were refreshed.`);
      let stat;
      try { stat = fs.lstatSync(path.join(root, destination)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && !stat.isFile()) throw Error(`Workflow dependency is not a regular file: ${destination}`);
      const planned = owner?.sources.find(([name]) => mapped(name, owner.copy) === destination);
      if (planned) {
        if (/\.ya?ml$/.test(planned[0])) queue.push({source: planned[0], entry: planned[1], target: destination});
        continue;
      }
      // Tracked, unrecorded helpers and acknowledged adaptations belong to the
      // seed. Equality never transfers that ownership, or untracked ownership.
      if (stat && (index.has(destination) || owner?.copy.adapted?.[destination])) continue;
      if (!stat && index.has(destination)) throw Error(`Workflow dependency ${destination} is tracked but missing; restore it before refresh-base; no files were refreshed.`);
      if (stat) throw Error(`Cannot refresh workflow dependency ${destination}: existing file has no Base copy record or Git index entry. Move it aside or explicitly record-base it before refresh-base; no files were refreshed.`);
      const candidates = [sourceRoot + invoked, 'default-seed/' + invoked,
        'export/' + (invoked.startsWith('.github/workflows/') ? path.posix.basename(invoked) : invoked.replace(/^scripts\//, '')),
        invoked.replace(/^scripts\//, '')];
      const dependency = candidates.find(name => tree.has(name));
      if (!dependency) throw Error(`No Base source for workflow dependency ${destination} invoked by ${target}; no files were refreshed.`);
      include(plans, destination, dependency, tree.get(dependency), revision);
      if (/\.ya?ml$/.test(dependency)) queue.push({source: dependency, entry: tree.get(dependency), target: destination});
    }
  }
}
