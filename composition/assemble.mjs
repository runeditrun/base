import {
  readFile,
  mkdir,
  writeFile,
  chmod,
  rm,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validate } from "../schema/json-schema.mjs";
import {
  commit,
  familyManifest,
  json,
  safePath,
  select,
  sha256,
  blob,
} from "./git-source.mjs";
const schema = JSON.parse(
  await readFile(new URL("../schema/COMPOSITION.schema.json", import.meta.url)),
);
const familySchema = JSON.parse(
  await readFile(new URL("../schema/FAMILY.schema.json", import.meta.url)),
);
export async function assemble({
  familyRepo,
  baseRepo,
  ref = "HEAD",
  edition,
  output,
  toolCommit,
}) {
  const familyCommit = commit(familyRepo, ref);
  const family = familyManifest(familyRepo, familyCommit);
  const familyErrors = validate(familySchema, family);
  if (familyErrors.length)
    throw new Error(`Invalid family.json: ${familyErrors.join("; ")}`);
  const baseCommit = commit(baseRepo, family.base.commit);
  if (baseCommit !== family.base.commit || toolCommit !== baseCommit)
    throw new Error(
      "Exporter must execute from the pinned base commit via cli.mjs",
    );
  safePath(edition);
  const descriptorPath = `compositions/${edition}.json`;
  const descriptor = json(familyRepo, familyCommit, descriptorPath);
  const errors = validate(schema, descriptor);
  if (errors.length)
    throw new Error(`Invalid composition: ${errors.join("; ")}`);
  if (
    descriptor.family !== family.id ||
    descriptor.edition !== edition ||
    descriptor.source !== `editions/${edition}`
  )
    throw new Error("Composition identity/source mismatch");
  const selected = new Set([
    descriptor.base,
    descriptor.family,
    ...descriptor.modules,
  ]);
  if (selected.size !== descriptor.modules.length + 2)
    throw new Error("Component IDs must be distinct");
  const files = new Map();
  const included = new Set();
  function add(file, target, component, repository) {
    safePath(target);
    if (files.has(target)) throw new Error(`Source collision: ${target}`);
    for (const path of files.keys())
      if (path.startsWith(`${target}/`) || target.startsWith(`${path}/`))
        throw new Error(`File/directory collision: ${target}`);
    const module = /^src\/modules\/([^/]+)\//.exec(target)?.[1];
    const domain = /^src\/family\/([^/]+)\//.exec(target)?.[1];
    if (
      (module && !descriptor.modules.includes(module)) ||
      (domain && domain !== family.id)
    )
      throw new Error(`Unselected component source: ${target}`);
    files.set(target, {
      ...file,
      component,
      repository,
      sha256: sha256(file.bytes),
    });
  }
  for (const file of select(familyRepo, familyCommit, descriptor.source)) {
    if (!file.relative) throw new Error("Edition source must be a directory");
    add(file, file.relative, edition, "family");
  }
  const moduleOrigins = new Map();
  for (const copy of descriptor.copies) {
    const consumerGuide =
      copy.repository === "family" &&
      copy.component === edition &&
      copy.source === `editions/${edition}/AGENTS.consumer.md` &&
      copy.target === "AGENTS.md";
    const isModule = descriptor.modules.includes(copy.component);
    const within = (directory) =>
      copy.source === directory || copy.source.startsWith(`${directory}/`);
    if (!consumerGuide && !selected.has(copy.component))
      throw new Error("Invalid component repository/selection");
    if (isModule) {
      if (!within(`modules/${copy.component}`))
        throw new Error("Module source outside its canonical directory");
      const origin = moduleOrigins.get(copy.component);
      if (origin && origin !== copy.repository)
        throw new Error(
          `Module has multiple repository origins: ${copy.component}`,
        );
      moduleOrigins.set(copy.component, copy.repository);
    } else if (!consumerGuide) {
      if (
        copy.component === family.id &&
        (copy.repository !== "family" || !within("core"))
      )
        throw new Error("Family core must come from its family repository");
      if (
        copy.component === descriptor.base &&
        (copy.repository !== "base" || within("modules"))
      )
        throw new Error(
          "Base source must come from base outside optional modules",
        );
    }
    const repo = copy.repository === "base" ? baseRepo : familyRepo;
    const sha = copy.repository === "base" ? baseCommit : familyCommit;
    for (const file of select(repo, sha, copy.source, { includeTests: copy.repository !== "base" }))
      add(
        file,
        file.relative ? `${copy.target}/${file.relative}` : copy.target,
        copy.component,
        copy.repository,
      );
    included.add(copy.component);
  }
  for (const component of [family.id, ...descriptor.modules])
    if (!included.has(component))
      throw new Error(`Selected component has no source: ${component}`);
  const composition = {
    base: descriptor.base,
    family: family.id,
    edition,
    modules: descriptor.modules,
  };
  if (
    !isDeepStrictEqual(
      JSON.parse(files.get("seed.json")?.bytes ?? "{}").composition,
      composition,
    )
  )
    throw new Error("seed.json composition mismatch");
  const pkg = JSON.parse(files.get("package.json")?.bytes ?? "{}");
  for (const name of ["dev", "verify", "setup", "deploy"])
    if (!pkg.scripts?.[name])
      throw new Error(`Missing edition command: ${name}`);
  const lock = {
    schemaVersion: 2,
    composition,
    repositories: {
      family: { repository: family.repository, commit: familyCommit },
      base: { repository: family.base.repository, commit: baseCommit },
    },
    assemblyTool: { repository: family.base.repository, commit: baseCommit },
    descriptor,
    descriptorSha256: sha256(blob(familyRepo, familyCommit, descriptorPath)),
    familyManifestSha256: sha256(blob(familyRepo, familyCommit, "family.json")),
    files: Object.fromEntries(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, f]) => [
          path,
          {
            sha256: f.sha256,
            mode: f.mode,
            component: f.component,
            repository: f.repository,
            source: f.path,
          },
        ]),
    ),
  };
  const target = resolve(output);
  const parent = await realpath(dirname(target));
  for (const repo of [familyRepo, baseRepo]) {
    const rel = relative(
      await realpath(repo),
      resolve(parent, target.slice(dirname(target).length + 1)),
    );
    if (
      !rel ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    )
      throw new Error("Output must be outside input repositories");
  }
  await mkdir(target);
  try {
    for (const [path, f] of files) {
      const dest = resolve(target, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.bytes, { flag: "wx", mode: f.mode });
      await chmod(dest, f.mode);
    }
    await writeFile(
      resolve(target, "composition.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { output: target, files: files.size, composition };
}
