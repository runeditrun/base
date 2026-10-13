#!/usr/bin/env node
// Bootstrap only: resolve committed family metadata, then execute the pinned base.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { commit, familyManifest, select, git } from "./git-source.mjs";
const [edition, ...args] = process.argv.slice(2);
const usage =
  "pnpm edition <edition> --family-repo <checkout> --base-repo <checkout> --output <new-directory> [--ref <commit>] [--install] [--verify] [--setup] [--deploy] [--dry-run] [--dev]";
if (!edition || edition === "--help") {
  console.log(usage);
  process.exit(0);
}
const options = { edition };
for (let i = 0; i < args.length; i++) {
  const name = args[i].slice(2);
  if (["family-repo", "base-repo", "output", "ref"].includes(name)) {
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`${args[i]} needs a value`);
    options[name] = args[++i];
  } else if (
    ["install", "verify", "setup", "deploy", "dry-run", "dev"].includes(name)
  )
    options[name] = true;
  else throw new Error(`Unknown argument ${args[i]}`);
}
for (const key of ["family-repo", "base-repo", "output"]) {
  if (!options[key]) throw new Error(usage);
  options[key] = resolve(options[key]);
}
if (
  !options.ref &&
  git(options["family-repo"], [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]).length
)
  throw new Error(
    "Family checkout is dirty; commit intended source or explicitly select --ref <commit>.",
  );
const familyCommit = commit(options["family-repo"], options.ref ?? "HEAD");
const manifest = familyManifest(options["family-repo"], familyCommit);
const baseCommit = commit(options["base-repo"], manifest.base.commit);
console.log(
  `Exporting ${manifest.repository}@${familyCommit} with ${manifest.base.repository}@${baseCommit}`,
);
const temporary = await mkdtemp(resolve(tmpdir(), "rer-pinned-base-"));
try {
  // Only committed tooling and schemas are loaded; no working-tree imports survive dispatch.
  for (const root of ["composition", "schema"])
    for (const file of select(options["base-repo"], baseCommit, root)) {
      const dest = resolve(temporary, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.bytes, { mode: file.mode });
    }
  const child = spawnSync(
    process.execPath,
    [
      resolve(temporary, "composition/run.mjs"),
      JSON.stringify({ ...options, ref: familyCommit, toolCommit: baseCommit }),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
