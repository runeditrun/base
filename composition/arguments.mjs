import { resolve } from "node:path";

export const usage =
  "pnpm edition <edition> --family-repo <checkout> --base-repo <checkout> --output <new-directory> [--ref <commit>] [--install] [--verify] [--setup] [--deploy] [--dry-run] [--dev]";

const valueFlags = new Set(["family-repo", "base-repo", "output", "ref"]);
const switchFlags = new Set(["install", "verify", "setup", "deploy", "dry-run", "dev"]);

// Parse source selection once, before reading committed family or Base inputs.
export function parseCompositionArgs(argv) {
  const [edition, ...args] = argv;
  if (!edition || edition === "--help") return null;
  const options = { edition };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    const name = argument.slice(2);
    if (!argument.startsWith("--") || (!valueFlags.has(name) && !switchFlags.has(name)))
      throw new Error(`Unknown argument ${argument}`);
    if (Object.hasOwn(options, name))
      throw new Error(`Repeated argument ${argument}; supply each flag only once`);
    if (valueFlags.has(name)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`${argument} needs a value`);
      options[name] = args[++i];
    } else options[name] = true;
  }
  for (const key of ["family-repo", "base-repo", "output"]) {
    if (!options[key]) throw new Error(usage);
    options[key] = resolve(options[key]);
  }
  return options;
}
