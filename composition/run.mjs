import { spawn } from "node:child_process";
import { assemble } from "./assemble.mjs";
const options = JSON.parse(process.argv[2]);
const result = await assemble({
  familyRepo: options["family-repo"],
  baseRepo: options["base-repo"],
  ref: options.ref,
  edition: options.edition,
  output: options.output,
  toolCommit: options.toolCommit,
});
console.log(
  `Assembled ${result.composition.edition}: ${result.files} editable files in ${result.output}`,
);
const run = (args) =>
  new Promise((done, fail) => {
    const child = spawn("pnpm", args, {
      cwd: result.output,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : fail(
            new Error(
              `pnpm ${args.join(" ")} failed (${signal ?? code}); source retained`,
            ),
          ),
    );
  });
if (options.install) await run(["install", "--frozen-lockfile"]);
if (options.verify) await run(["run", "verify"]);
for (const command of ["setup", "deploy"])
  if (options[command])
    await run(["run", command, ...(options["dry-run"] ? ["--dry-run"] : [])]);
if (options.dev) await run(["run", "dev"]);
