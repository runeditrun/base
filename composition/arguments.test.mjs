import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, access } from "node:fs/promises";
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

test("edition commands bind source selection and refuse repeated flags without creating an export", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "rer-composition-arguments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = resolve(root, "base"), family = resolve(root, "family");
  for (const repo of [base, family]) {
    await mkdir(repo);
    git(repo, "init", "-q");
  }
  for (const directory of ["composition", "schema"])
    await cp(resolve(source, directory), resolve(base, directory), { recursive: true });
  await put(base, "schema/migration-draft.sql", "-- schema draft\nCREATE TABLE replacement (id INTEGER);\n");
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
  const migration = "migrations/core/0001_owner.sql";
  const historical = "CREATE TABLE original (id INTEGER);\n";
  await put(family, `editions/${composition.edition}/${migration}`, historical);
  const revision = checkpoint(family);
  for (const entry of ["edition-authoring/compose.mjs", "composition/cli.mjs"]) {
    const run = (output, extra = [], ref = revision) => spawnSync(process.execPath, [
      resolve(source, entry), composition.edition,
      "--family-repo", family, "--base-repo", base, "--output", output,
      ...(ref ? ["--ref", ref] : []), ...extra,
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
    await put(family, "core/src/domain.mjs", "uncommitted source\n");
    const dirtyOutput = resolve(root, `${entry.split("/")[0]}-dirty`);
    const dirty = run(dirtyOutput, [], null);
    assert.notEqual(dirty.status, 0);
    assert.equal(dirty.stdout, '');
    await assert.rejects(access(dirtyOutput), { code: "ENOENT" });
    const explicit = run(resolve(root, `${entry.split("/")[0]}-explicit-dirty`));
    assert.equal(explicit.status, 0, explicit.stderr);
    git(family, "checkout", "--", "core/src/domain.mjs");
  }

  const descriptorPath = `compositions/${composition.edition}.json`;
  const descriptor = JSON.parse(git(family, "show", `${revision}:${descriptorPath}`));
  descriptor.copies.push({ repository: "base", component: "base", source: "schema/migration-draft.sql", target: migration });
  await put(family, descriptorPath, descriptor);
  await rm(resolve(family, `editions/${composition.edition}/${migration}`));
  const legacy = checkpoint(family);
  git(family, "checkout", "--detach", revision);

  const shim = resolve(root, "git-bin"), marker = resolve(root, "checkout-status");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await mkdir(shim);
  // Delegate every read to real Git. Move the real checkout only after the
  // preflight's authentic SAFE descriptor has been read, before it returns.
  await writeFile(resolve(shim, "git"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const [real, family, safe, legacy, marker, descriptor] = ${JSON.stringify([realGit, family, revision, legacy, marker, descriptorPath])};
const args = process.argv.slice(2);
const result = spawnSync(real, args);
if (!existsSync(marker) && JSON.stringify(args.filter(arg => arg !== "--no-replace-objects")) === JSON.stringify(["-C", family, "show", safe + ":" + descriptor])) {
  const moved = spawnSync(real, ["-C", family, "checkout", "--detach", legacy]);
  writeFileSync(marker, String(moved.status));
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const output = resolve(root, "head-race");
  const raced = spawnSync(process.execPath, [
    resolve(source, "edition-authoring/compose.mjs"), composition.edition,
    "--family-repo", family, "--base-repo", base, "--output", output,
  ], { encoding: "utf8", env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(await readFile(marker, "utf8"), "0");
  assert.equal(git(family, "rev-parse", "HEAD"), legacy);
  assert.equal(raced.status, 0, raced.stderr);
  assert.equal(await readFile(resolve(output, migration), "utf8"), historical);
  const lock = JSON.parse(await readFile(resolve(output, "composition.lock.json"), "utf8"));
  assert.equal(lock.repositories.family.commit, revision);
});
