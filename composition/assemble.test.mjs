import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const baseSource = fileURLToPath(new URL("../", import.meta.url));
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function put(root, path, value) {
  await mkdir(resolve(root, path, ".."), { recursive: true });
  await writeFile(
    resolve(root, path),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function checkpoint(repo) {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "source",
  );
  return git(repo, "rev-parse", "HEAD");
}
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "rer-export-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = resolve(root, "base"),
    family = resolve(root, "family");
  for (const repo of [base, family]) {
    await mkdir(repo);
    git(repo, "init", "-q");
  }
  for (const dir of ["composition", "schema"])
    await cp(resolve(baseSource, dir), resolve(base, dir), { recursive: true });
  await put(base, "shared/runtime.mjs", "export const runtime = true;\n");
  await put(base, "shared/runtime.test.mjs", "throw Error('Base test');\n");
  await put(base, "shared/tests/helper.mjs", "throw Error('Base fixture');\n");
  const sha = checkpoint(base);
  await put(family, "family.json", {
    schemaVersion: 1,
    id: "support",
    repository: "just-every/run-happytohelp",
    base: { repository: "runeditrun/base", commit: sha },
  });
  const composition = {
    base: "base",
    family: "support",
    edition: "lily",
    modules: ["mail"],
  };
  await put(family, "compositions/lily.json", {
    schemaVersion: 2,
    ...composition,
    source: "editions/lily",
    copies: [
      {
        repository: "family",
        component: "support",
        source: "core/src",
        target: "src/family/support",
      },
      {
        repository: "family",
        component: "mail",
        source: "modules/mail/src",
        target: "src/modules/mail",
      },
      {
        repository: "base",
        component: "base",
        source: "shared",
        target: "src/base",
      },
    ],
  });
  await put(family, "editions/lily/seed.json", { composition });
  await put(family, "editions/lily/package.json", {
    scripts: { dev: "true", verify: "true", setup: "true", deploy: "true" },
  });
  await put(family, "core/src/domain.ts", "export const domain = true;\n");
  await put(family, "modules/mail/src/mail.ts", "export const mail = true;\n");
  await put(family, "modules/mail/src/mail.test.ts", "export const seedTest = true;\n");
  await put(family, "modules/unselected/src/private.ts", "not selected");
  checkpoint(family);
  return { root, base, family };
}
function run(f, output, extra = []) {
  return spawnSync(
    process.execPath,
    [
      resolve(baseSource, "composition/cli.mjs"),
      "lily",
      "--family-repo",
      f.family,
      "--base-repo",
      f.base,
      "--output",
      output,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}
function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
}
test("committed export relocates byte-identically and ignores explicit-ref dirty bytes", async (t) => {
  const f = await fixture(t);
  const out = resolve(f.root, "one");
  succeeds(run(f, out));
  const clone = resolve(f.root, "clone");
  git(f.root, "clone", "-q", f.family, clone);
  const baseClone = resolve(f.root, "baseclone");
  git(f.root, "clone", "-q", f.base, baseClone);
  succeeds(
    run({ ...f, family: clone, base: baseClone }, resolve(f.root, "two")),
  );
  assert.deepEqual(
    await readFile(resolve(out, "composition.lock.json")),
    await readFile(resolve(f.root, "two/composition.lock.json")),
  );
  await put(f.family, "core/src/domain.ts", "dirty");
  assert.notEqual(run(f, resolve(f.root, "dirty")).status, 0);
  succeeds(
    run(f, resolve(f.root, "explicit"), [
      "--ref",
      git(f.family, "rev-parse", "HEAD"),
    ]),
  );
  assert.equal(
    await readFile(
      resolve(f.root, "explicit/src/family/support/domain.ts"),
      "utf8",
    ),
    "export const domain = true;\n",
  );
  const lock = JSON.parse(
    await readFile(resolve(out, "composition.lock.json")),
  );
  assert.ok(!JSON.stringify(lock).includes(f.root));
  assert.ok(!Object.keys(lock.files).some((p) => p.includes("unselected")));
  assert.ok(lock.files["src/base/runtime.mjs"]);
  assert.ok(lock.files["src/modules/mail/mail.test.ts"]);
  assert.ok(!Object.keys(lock.files).some(p => p.startsWith("src/base/") && /\.test\.|\/tests\//.test(p)));
  await assert.rejects(readFile(resolve(out, "src/base/runtime.test.mjs")), { code: "ENOENT" });
  for (const path of Object.keys(lock.files))
    assert.deepEqual(
      await readFile(resolve(out, path)),
      await readFile(resolve(f.root, "two", path)),
    );
  assert.notEqual(run(f, out, ["--ref", "HEAD"]).status, 0);
});
test("pinned tooling ignores working base edits", async (t) => {
  const f = await fixture(t);
  await put(
    f.base,
    "composition/assemble.mjs",
    'throw new Error("DIRTY TOOL");',
  );
  succeeds(run(f, resolve(f.root, "out")));
});
for (const kind of [
  "collision",
  "symlink",
  "state",
  "escape",
  "missing-pin",
  "unselected",
])
  test(`rejects ${kind}`, async (t) => {
    const f = await fixture(t);
    if (kind === "collision")
      await put(
        f.family,
        "editions/lily/src/family/support/domain.ts",
        "same or different still collision",
      );
    if (kind === "symlink")
      await symlink("domain.ts", resolve(f.family, "core/src/link.ts"));
    if (kind === "state")
      await put(f.family, "editions/lily/.env", "SECRET=test");
    if (kind === "unselected")
      await put(
        f.family,
        "editions/lily/src/modules/other/code.ts",
        "unselected",
      );
    if (kind === "escape") {
      const p = resolve(f.family, "compositions/lily.json");
      const d = JSON.parse(await readFile(p));
      d.copies[0].target = "../escape";
      await writeFile(p, JSON.stringify(d));
    }
    if (kind === "missing-pin") {
      const p = resolve(f.family, "family.json");
      const d = JSON.parse(await readFile(p));
      d.base.commit = "0".repeat(40);
      await writeFile(p, JSON.stringify(d));
    }
    checkpoint(f.family);
    assert.notEqual(run(f, resolve(f.root, "out")).status, 0);
  });
test("Git replacement objects cannot change pinned source", async (t) => {
  const f = await fixture(t);
  const original = git(f.family, "rev-parse", "HEAD");
  await put(f.family, "core/src/domain.ts", "replacement");
  const replacement = checkpoint(f.family);
  git(f.family, "replace", original, replacement);
  succeeds(run(f, resolve(f.root, "out"), ["--ref", original]));
  assert.equal(
    await readFile(resolve(f.root, "out/src/family/support/domain.ts"), "utf8"),
    "export const domain = true;\n",
  );
});
test("control characters in committed paths are rejected", async (t) => {
  const f = await fixture(t);
  await put(f.family, "core/src/tab\tname.ts", "bad path");
  checkpoint(f.family);
  assert.notEqual(run(f, resolve(f.root, "out")).status, 0);
});
test("output whose name starts with dots still cannot be inside an input", async (t) => {
  const f = await fixture(t);
  assert.notEqual(run(f, resolve(f.family, "..export")).status, 0);
});
test("consumer instructions are explicitly emitted without governing author source", async (t) => {
  const f = await fixture(t);
  await put(
    f.family,
    "editions/lily/AGENTS.consumer.md",
    "Owner may edit any source.\n",
  );
  const path = resolve(f.family, "compositions/lily.json");
  const d = JSON.parse(await readFile(path));
  d.copies.push({
    repository: "family",
    component: "lily",
    source: "editions/lily/AGENTS.consumer.md",
    target: "AGENTS.md",
  });
  await writeFile(path, JSON.stringify(d));
  checkpoint(f.family);
  succeeds(run(f, resolve(f.root, "out")));
  assert.equal(
    await readFile(resolve(f.root, "out/AGENTS.md"), "utf8"),
    "Owner may edit any source.\n",
  );
  const lock = JSON.parse(
    await readFile(resolve(f.root, "out/composition.lock.json")),
  );
  assert.equal(
    lock.files["AGENTS.md"].source,
    "editions/lily/AGENTS.consumer.md",
  );
});
test("bootstrap ignores uncommitted family schema and validator changes", async (t) => {
  const f = await fixture(t);
  await put(f.base, "schema/FAMILY.schema.json", {
    type: "object",
    required: ["futureField"],
  });
  await put(
    f.base,
    "schema/json-schema.mjs",
    'throw new Error("UNPINNED VALIDATOR");',
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(f.base, "composition/cli.mjs"),
      "lily",
      "--family-repo",
      f.family,
      "--base-repo",
      f.base,
      "--output",
      resolve(f.root, "out"),
    ],
    { encoding: "utf8" },
  );
  succeeds(result);
});
async function baseModuleFixture(t) {
  const f = await fixture(t);
  await put(
    f.base,
    "modules/mail/src/mail.ts",
    "export const sharedMail = true;\n",
  );
  await put(f.base, "modules/omitted/src/other.ts", "not selected");
  const baseCommit = checkpoint(f.base);
  const manifest = JSON.parse(await readFile(resolve(f.family, "family.json")));
  manifest.base.commit = baseCommit;
  await put(f.family, "family.json", manifest);
  const descriptor = JSON.parse(
    await readFile(resolve(f.family, "compositions/lily.json")),
  );
  descriptor.copies[1].repository = "base";
  await put(f.family, "compositions/lily.json", descriptor);
  return { ...f, descriptor };
}
test("selected cross-family module exports from base; omitted modules stay absent", async (t) => {
  const f = await baseModuleFixture(t);
  checkpoint(f.family);
  const out = resolve(f.root, "out");
  succeeds(run(f, out));
  const lock = JSON.parse(
    await readFile(resolve(out, "composition.lock.json")),
  );
  assert.equal(
    await readFile(resolve(out, "src/modules/mail/mail.ts"), "utf8"),
    "export const sharedMail = true;\n",
  );
  assert.equal(lock.files["src/modules/mail/mail.ts"].repository, "base");
  assert.ok(!Object.keys(lock.files).some((path) => path.includes("omitted")));
});
for (const kind of [
  "mixed-origin",
  "wrong-module-path",
  "unselected-base-module",
  "core-from-base",
  "module-as-base",
])
  test(`rejects ${kind}`, async (t) => {
    const f = await baseModuleFixture(t);
    const d = f.descriptor;
    if (kind === "mixed-origin")
      d.copies.push({
        repository: "family",
        component: "mail",
        source: "modules/mail/src",
        target: "another-mail",
      });
    if (kind === "wrong-module-path")
      d.copies[1].source = "modules/omitted/src";
    if (kind === "unselected-base-module") d.copies[1].component = "omitted";
    if (kind === "core-from-base") d.copies[0].repository = "base";
    if (kind === "module-as-base") d.copies[1].component = "base";
    await put(f.family, "compositions/lily.json", d);
    checkpoint(f.family);
    assert.notEqual(run(f, resolve(f.root, "out")).status, 0);
  });
