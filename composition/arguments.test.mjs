import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("../", import.meta.url));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
async function put(root, path, data) {
  const destination = resolve(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, typeof data === "string" ? data : JSON.stringify(data));
}
function checkpoint(repo) {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Run Edit Run fleet", "-c", "user.email=test@example.invalid", "commit", "-qm", "synthetic composition");
  return git(repo, "rev-parse", "HEAD");
}

test("edition commands refuse repeated source-selection flags without creating an export", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "rer-composition-arguments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = resolve(root, "base"), family = resolve(root, "family");
  for (const repo of [base, family]) {
    await mkdir(repo);
    git(repo, "init", "-q");
  }
  for (const directory of ["composition", "schema"])
    await cp(resolve(source, directory), resolve(base, directory), { recursive: true });
  const baseCommit = checkpoint(base);
  await put(family, "family.json", {
    schemaVersion: 1, id: "synthetic-family-1", repository: "just-every/run-happytohelp",
    base: { repository: "runeditrun/base", commit: baseCommit },
  });
  const composition = { base: "base", family: "synthetic-family-1", edition: "synthetic-edition-1", modules: [] };
  await put(family, "compositions/synthetic-edition-1.json", {
    schemaVersion: 2, ...composition, source: "editions/synthetic-edition-1",
    copies: [{ repository: "family", component: composition.family, source: "core/src", target: "src/family/synthetic-family-1" }],
  });
  await put(family, "editions/synthetic-edition-1/seed.json", { composition });
  await put(family, "editions/synthetic-edition-1/package.json", {
    scripts: { dev: "true", verify: "true", setup: "true", deploy: "true" },
  });
  await put(family, "core/src/domain.mjs", "export const domain = true;\n");
  const revision = checkpoint(family);
  for (const entry of ["edition-authoring/compose.mjs", "composition/cli.mjs"]) {
    const run = (output, extra = []) => spawnSync(process.execPath, [
      resolve(source, entry), composition.edition,
      "--family-repo", family, "--base-repo", base, "--output", output,
      "--ref", revision, ...extra,
    ], { encoding: "utf8" });
    // A successful control makes refusals distinguishable from invalid fixtures.
    const control = run(resolve(root, `${entry.split("/")[0]}-control`));
    assert.equal(control.status, 0, control.stderr);
    for (const [flag, value] of [["family-repo", family], ["base-repo", base], ["ref", revision], ["output", null]]) {
      const output = resolve(root, `${entry.split("/")[0]}-${flag}`);
      const refused = run(output, [`--${flag}`, value ?? output]);
      assert.equal(refused.error, undefined);
      assert.notEqual(refused.status, 0, `${entry} accepted repeated --${flag}`);
      await assert.rejects(access(output), { code: "ENOENT" });
    }
  }
});
