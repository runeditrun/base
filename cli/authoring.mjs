import {adoptEdition} from '../edition-authoring/adopt.mjs';
import {resolve} from 'node:path';
import {refreshCopies, options as copyOptions} from '../edition-authoring/base-copies.mjs';
import {refuse, invalid} from './errors.mjs';

export function authoringCommand(options) {
 if (options.verb === 'refresh-base' && !options.ref) throw invalid('Provide --ref with the full immutable Base commit. Run rer refresh-base --help.');
 try {
  return options.verb === 'adopt-edition' ? adoptEdition(options.cwd) : refreshCopies(options.cwd, copyOptions([
   ...(options.editionMigration ? options.editionMigration.split(',').flatMap(id => ['--edition-migration', id]) : []),
   options.ref, '--record', options.record ?? 'base-copies.json',
   ...(options.base ? ['--base', resolve(options.cwd, options.base)] : []), ...(options.offline ? ['--offline'] : []),
  ], 1));
 } catch (error) { throw refuse(error.message); }
}
