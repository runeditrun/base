// Repository acquisition belongs to the global CLI, before checkout dispatch.
export const repositoryCommands = Object.freeze({
 business: { usage: 'rer business sync [--app ID] [--leave]', effects: 'Pull signed Business settings with this computer pairing; save public trust for dev and deploy, then post to the running app. Leave removes the checkout membership and trust while keeping applied values.' },
 install: { usage: 'rer install <repo> [--dir DIR] [FLAGS]', effects: 'Install rer for this user, clone or reuse the repository, install its dependencies, then stop.' },
 setup: { usage: 'rer setup <repo> [--dir DIR] [FLAGS]', effects: 'Install rer, clone or reuse the repository, install dependencies and set up a local owner, then print the dev command.' },
 dev: { usage: 'rer dev <repo> [--dir DIR] [FLAGS]', effects: 'Install rer, clone or reuse the repository, install and set up as needed, then start dev and print RER_READY and RER_OPEN.' },
});
export const repositoryHelp = 'Repository: <owner>/<repo>, a GitHub HTTPS URL (with or without .git), or a git URL.\nClones into ./<repo-name>; --dir overrides. Reuses a clone with the same origin; refuses any other non-empty folder.\n';
