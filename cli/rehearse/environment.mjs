import {join} from 'node:path';

// An allowlist keeps provider credentials, Git config and caller startup hooks out.
// HOME/config/cache are private and fresh; PATH supplies the caller's build tools.
export function rehearsalEnvironment(home, artifactFile) {
 return {PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, TMP: home, TEMP: home,
  XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
  CI: 'true', ARTIFACT_FILE: artifactFile, VERIFICATION_PROFILE: 'full',
  LANG: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'Rehearsal', GIT_AUTHOR_EMAIL: 'rehearsal@example.invalid',
  GIT_COMMITTER_NAME: 'Rehearsal', GIT_COMMITTER_EMAIL: 'rehearsal@example.invalid',
  WRANGLER_SEND_METRICS: 'false', RER_UPDATE_CHECK: '0'};
}
