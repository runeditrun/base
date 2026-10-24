// Repository acquisition belongs to the global CLI, before checkout dispatch.
export const repositoryCommands = Object.freeze({
 install: { usage: 'rer install <repo> [--dir DIR] [FLAGS]', effects: 'Install rer for this user, clone or reuse the repository, install its dependencies, then stop.' },
 setup: { usage: 'rer setup <repo> [--dir DIR] [FLAGS]', effects: 'Install rer, clone or reuse the repository, install dependencies and set up a local owner, then print the dev command.' },
 dev: { usage: 'rer dev <repo> [--dir DIR] [--guide CODE] [FLAGS]', effects: 'Install rer, clone or reuse the repository, install and set up as needed, then start dev and print RER_READY and RER_OPEN. --guide CODE (the code a Run guide page shows) also reports the phase it is in (get, install, database, start, ready or failed with an error_code) to that page, and nothing else, best effort: it never delays or stops the launch.' },
});
export const repositoryHelp = 'Repository: <owner>/<repo>, a GitHub HTTPS URL (with or without .git), or a git URL.\nClones into ./<repo-name>; --dir overrides. Reuses a clone with the same origin; refuses any other non-empty folder.\n';
