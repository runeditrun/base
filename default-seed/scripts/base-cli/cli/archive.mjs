import { Readable } from 'node:stream';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { diffArchives } from '../modules/portability/diff.mjs';
import { readArchive, PortabilityError } from '../modules/portability/index.mjs';
import { RerError, invalid, missing } from './errors.mjs';

const usage = `Usage: rer archive diff BEFORE AFTER
Verify two installation archives (.rer files made by rer export) completely, then print
as JSON the row keys, objects and payloads AFTER added, removed or changed. It never
merges writes and does not print row values.`;
const next = 'choose a .rer archive made by rer export, then run rer archive diff BEFORE AFTER.';

export async function archiveCommand(args,out) {
 if (args.includes('--help') || args.includes('-h')) { out.human(usage); return 0; }
 if (args.length!==3 || args[0]!=='diff') throw invalid('Usage: rer archive diff BEFORE AFTER');
 const files=[['BEFORE',args[1]],['AFTER',args[2]]];
 for (const [role,path] of files) await readable(role,path);
 let result;
 try { result=await diffArchives(source(args[1]),source(args[2])); }
 catch (error) { throw await explained(error,files); }
 out.human(JSON.stringify(result,null,2)); return 0;
}

const source = path => Readable.toWeb(createReadStream(path));

async function readable(role,path) {
 let status;
 try { status=await stat(path); await access(path,constants.R_OK); }
 catch (error) {
  if (['ENOENT','ENOTDIR'].includes(error.code)) throw missing(`Cannot read ${role} (${path}): there is no such file. Correct the path, or ${next}`);
  throw new RerError('command_failed',`Cannot read ${role} (${path}): ${['EACCES','EPERM'].includes(error.code)?'permission denied':`it could not be opened (${error.code ?? 'read error'})`}. Make it readable, or ${next}`,1);
 }
 if (status.isDirectory()) throw invalid(`Cannot read ${role} (${path}): it is a folder. Instead, ${next}`);
 if (!status.isFile()) throw invalid(`Cannot read ${role} (${path}): it is not a regular file. Instead, ${next}`);
}

// Both archives are read at once, so a failed check does not say which one it
// was: verify each again, one at a time, to name it.
async function explained(error,files) {
 if (/different products/.test(error?.message)) return new RerError('invalid_archive','BEFORE and AFTER are archives of different products, so they cannot be compared. Choose two archives exported from the same installation, then run rer archive diff BEFORE AFTER.',1);
 if (!unreadableArchive(error)) return error;
 for (const [role,path] of files) {
  try { for await (const record of readArchive(source(path))) {} }
  catch (failure) { if (unreadableArchive(failure)) return damaged(role,path,failure); throw failure; }
 }
 return error;
}

const lineLimit = error => /archive line exceeds/.test(error?.message);
const unreadableArchive = error => error instanceof PortabilityError || lineLimit(error);

// The archive reader's codes, as the problem a person can act on.
function damaged(role,path,error) {
 const code=lineLimit(error)?'archive_json':error.code;
 const cause=code==='archive_json' ? 'it is not an installation archive, or its text is damaged'
  : code==='archive_format' ? 'it is not an installation archive this rer reads (unknown format or version)'
  : code==='legacy_archive_unverifiable' ? 'it is a version 1 archive, whose contents rer cannot verify'
  : ['closing_missing','part_count','archive_incomplete','rows_missing'].includes(code) ? 'it is incomplete (the file ends before the archive does, as when a copy or download is cut short)'
  : 'it is damaged (its contents do not match the checksums recorded when it was exported)';
 return new RerError('invalid_archive',`Cannot read ${role} (${path}): ${cause}. Use an intact copy, or make a new archive from the installation with rer export --output exports/NAME.rer, then run rer archive diff BEFORE AFTER.`,1);
}
