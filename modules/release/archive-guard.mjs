import { archiveMembers } from './archive-members.mjs';

const normal = path => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

// macOS tar writes a `._<name>` AppleDouble member beside every file and
// directory that has extended attributes. The export is the tracked tree and
// nothing else: such a member is refused unless a tracked path is that name.
export function assertTrackedMembers(members, trackedPaths) {
  const tracked = new Set();
  for (const path of trackedPaths) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) tracked.add(parts.slice(0, length).join('/'));
  }
  const stray = members.map(member => normal(member.path)).filter(path => path && path.split('/').pop().startsWith('._') && !tracked.has(path));
  if (stray.length)
    throw Error(`Public export archive holds ${stray.length} AppleDouble entr${stray.length === 1 ? 'y' : 'ies'} that are not tracked paths (first: ${stray[0]}). `
      + 'macOS tar adds them from extended attributes; the release was stopped before any digest was recorded.');
}

export function assertArchiveTracked(archive, trackedPaths) {
  assertTrackedMembers(archiveMembers(archive), trackedPaths);
}
