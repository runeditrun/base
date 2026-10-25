// Literal POSIX quoting for first-run next steps and cached runtime commands.
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
