// Every message rer business prints names its cause: a server's reason, a
// local system cause, or this CLI's own explanation. Device and task bearers
// are redacted wherever a message came from.
const causes = {
 EACCES: 'permission denied', EPERM: 'not permitted here (an agent sandbox can block this)', EROFS: 'the disk is read-only',
 ENOSPC: 'the disk is full', EDQUOT: 'the disk quota is used up', ENOENT: 'it does not exist', ENOTDIR: 'part of the path is not a folder',
 EEXIST: 'it already exists', EISDIR: 'it is a folder', ELOOP: 'it is a symbolic link loop', EMFILE: 'too many files are open', EBUSY: 'it is busy',
};
const actions = { open: 'open', mkdir: 'create', write: 'write', rename: 'replace', unlink: 'remove', rmdir: 'remove', rm: 'remove', chmod: 'protect', read: 'read', lstat: 'check', stat: 'check', scandir: 'list', access: 'check' };

export const localCause = error => typeof error?.code === 'string' ? causes[error.code] ? `${causes[error.code]} (${error.code})` : error.code : null;
export const redact = text => String(text).replace(/bz_[a-z]+_[A-Za-z0-9_-]+/g, '[credential]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');

export function describe(error) {
 if (typeof error?.syscall === 'string' && typeof error.code === 'string') {
  return redact(`Business could not ${actions[error.syscall] ?? error.syscall} ${error.path ?? 'a local file'}: ${localCause(error)}.`);
 }
 const message = error instanceof Error ? error.message : String(error);
 const unexpected = [TypeError, RangeError, SyntaxError, ReferenceError].some(type => error instanceof type);
 return redact(unexpected || !message ? `Business command failed unexpectedly: ${message || 'no reason given'}` : message);
}

// An exit status other than 1 travels with the error (130 after Ctrl-C).
export class Stopped extends Error {
 constructor(message, exitCode) { super(message); this.exitCode = exitCode; }
}
