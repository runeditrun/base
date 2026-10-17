// Select rer's own pinned tools without promoting their neighbouring programs
// ahead of the caller's PATH. Arbitrary project tools keep normal PATH lookup.
export function toolCommand(command, args = [], env = process.env) {
 if (command === 'pnpm' && env.RER_PNPM_ENTRY) return [env.RER_NODE_BINARY ?? process.execPath, [env.RER_PNPM_ENTRY, ...args]];
 if (command === 'node' && env.RER_NODE_BINARY) return [env.RER_NODE_BINARY, args];
 return [command, args];
}
