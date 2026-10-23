#!/usr/bin/env node
// Check committed family migration mappings before dispatching pinned tooling.
import {commit, familyManifest, json, select} from '../composition/git-source.mjs';
import {parseCompositionArgs, usage} from '../composition/arguments.mjs';
import {dispatchComposition} from '../composition/cli.mjs';

const args = process.argv.slice(2);
try {
  const options = parseCompositionArgs(args);
  if (options) {
    const {edition, 'family-repo': family, 'base-repo': base} = options;
    const revision = commit(family, options.ref ?? 'HEAD');
    const manifest = familyManifest(family, revision);
    const baseRevision = commit(base, manifest.base.commit);
    const descriptor = json(family, revision, `compositions/${edition}.json`);
    for (const copy of descriptor.copies) {
      if (copy.repository !== 'base' || !/(?:^|\/)migrations\//.test(copy.target)) continue;
      for (const file of select(base, baseRevision, copy.source)) {
        if (file.path !== 'modules/operator-auth/accounts/schema/operator-auth.sql' && !/schema draft/i.test(file.bytes.toString('utf8').split('\n')[0])) continue;
        throw Error(`Refusing aggregate draft mapping ${file.path} -> ${copy.target} in compositions/${edition}.json before composition. In the existing edition, run adapt-base ${copy.target} so its recorded bytes are frozen. Retain those historical bytes in ${descriptor.source}/${copy.target}, remove the draft mapping, and commit the family. Add new schema as a NEW numbered migration, then refresh-base; see foundation/README.md (existing families).`);
      }
    }
    // Keep the checked commit and original ref intent together: implicit HEAD
    // must still require a clean checkout when the dispatcher starts.
    process.exitCode = await dispatchComposition(options, revision);
  } else console.log(usage);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
