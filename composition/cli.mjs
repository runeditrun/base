#!/usr/bin/env node
// Bootstrap only: resolve committed family metadata, then execute the pinned base.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commit, familyManifest, select, git } from "./git-source.mjs";
import { parseCompositionArgs, usage } from "./arguments.mjs";
export async function dispatchComposition(options, familyCommit) {
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
  familyCommit ??= commit(options["family-repo"], options.ref ?? "HEAD");
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
    return child.status ?? 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCompositionArgs(process.argv.slice(2));
  if (options) process.exitCode = await dispatchComposition(options);
  else console.log(usage);
}
