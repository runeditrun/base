# Source boundary checker

A dependency-free source module for the `src/core/` and `src/ext/` convention.
It uses the consumer project's TypeScript through `createRequire` anchored at
its `package.json`, supporting TypeScript 5.9 and 6. Copy source into the seed;
there is no runtime package or Base checkout dependency.

```js
import { checkBoundaries } from './vendor/base/modules/boundary-checker/index.mjs'
const result = await checkBoundaries({ root: process.cwd(), config: { version: 1 } })
```

The async API returns `{files, violations}`. `files` is the number of scanned
source files. Every violation has `rule`, `file`, `line`, `column`, `specifier`,
`target` and `message`. Locations are one-based; paths are root-relative POSIX.
A missing or external target, and a finding without an import, use `null`.
Findings sort by file, line, rule, then column. Unresolved imports are not
configuration errors; specifier rules still apply to them.

```sh
node vendor/base/modules/boundary-checker/cli.mjs
node vendor/base/modules/boundary-checker/cli.mjs --config /path/to/seed/boundaries.json --json
```

A config directory containing `package.json` is the project root, including
when invoked from another working directory. Otherwise the working directory
is the root, allowing an external config to check an existing project. The
default path is `boundaries.json` in the working directory. Keep it at the seed root. Exit 0 prints `Boundary check passed for N source
files.`; exit 1 prints `Boundary check failed with N violation(s):` and a line
`- <file>:<line> <rule>: <message>` per finding. Failures go to stderr, passes to
stdout. `--json` emits the complete result on the same stream and retains the
exit code. Exit 2 names a configuration or usage error on stderr, also with
`--json`. A missing config, tsconfig or consumer TypeScript is an error.

## Rules and defaults

| Rule | Default behavior |
| --- | --- |
| R1 | ext imports core only under `src/core/api/` or `src/core/shared/`. |
| R2 | core imports ext only from declared mount files; none are declared. |
| R3 | cross-feature imports reach the other feature's `index.ts` or `index.tsx`. |
| R4 | Imports from the D1 entry point of `drizzle-orm` occur only in `repository.ts` or `*-repository.ts`. |
| R5 | `cloudflare:*` imports anywhere, and environment reads under core, occur only under `src/core/platform/` or `src/core/app/`. |
| R6 | reject calls to `eval`, `new Function`, and non-literal dynamic imports. |
| R7 | selected client entries cannot directly import server, repository or service files; no entries selected. |
| R8 | selected owner files must start with `/**`; disabled and no files selected. |

Import declarations (including type-only), `export * from`, named re-exports and
literal dynamic imports all count. Literals include no-substitution templates.
The TypeScript AST excludes comments and strings from environment/evaluation
checks. R5 recognizes property accesses `x.env`, `env.X` and `environment.X`,
including optional property access; it does not infer variable aliases or inspect
computed access. R6 checks the named syntax even if a local variable shadows it.
This is a direct-import checker, not a transitive client-bundle or runtime audit.

Scan every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` file,
including declarations, beneath `sourceRoot`. The tsconfig controls resolution,
not scan inclusion. Its `paths`, relative imports and directory indexes work.
Symlink directories are skipped to avoid cycles; linked source files and nested
dependency folders are scanned. Resolved targets use physical paths. Path rules ignore outside-root and `node_modules`
targets. Specifier rules still match bare packages, including unresolved ones.

## Configuration reference

`boundaries.json` is plain JSON. Start with `{"version":1}`. Unknown keys,
wrong types, malformed glob/regex patterns, traversal and missing tsconfig fail.
All rule options merge with defaults. Set a rule to `false` or set its
`enabled` option to `false`. R8 needs `enabled:true` when selecting files.

| Key | Default / meaning |
| --- | --- |
| `version` | Required, exactly `1`. |
| `sourceRoot` | `src`; relative POSIX directory. |
| `tsconfig` | `tsconfig.json`; relative POSIX file. Nested configs and `extends` resolve from their directory. |
| `includeTypeOnly` | `true`; `false` skips entirely type-only import/export declarations. Mixed declarations still count. |
| `rules.R1.allowedPrefixes` | `['src/core/api','src/core/shared']`; allowed target directories. |
| `rules.R2.mounts` | `[]`; exact source file list permitting any ext target, or an object mapping each mount to exact resolved target paths (arrays). `true` permits any target for that mount. |
| `rules.R3.exceptions` | `[]`; exact resolved target files allowed across features. |
| `rules.R4.specifiers` | `['drizzle-orm/d1']`; exact restricted specifiers. |
| `rules.R4.specifierPrefixes` | `[]`; restricted specifier prefixes, such as `drizzle-orm`. |
| `rules.R4.clientModules` | `[]`; resolved restricted module paths, with or without a source extension. |
| `rules.R4.allowedFiles` | `['**/repository.ts','**/*-repository.ts']`; source file globs. |
| `rules.R4.allowedDirectories` | `[]`; source directories allowed database imports. |
| `rules.R5.importScopes` | `['**']`; source file globs for platform specifiers. |
| `rules.R5.environmentScopes` | `['src/core/**']`; source file globs for environment property access. |
| `rules.R5.specifierPatterns` | `['cloudflare:*']`; specifier globs. |
| `rules.R5.allowedDirectories` | `['src/core/platform','src/core/app']`; sources allowed bindings. |
| `rules.R6.enabled` | `true`; evaluation syntax checking. |
| `rules.R7.files` | `[]`; client entry source globs. |
| `rules.R7.pattern` | `(server\|repository\|service)\\.[cm]?[jt]sx?$`; regex source matched against resolved target paths. |
| `rules.R8.files` | `[]`; owner source globs. |
| `rules.R8.prefix` | `/**`; exact prefix at byte zero, so leading whitespace/BOM does not count. |

Directory paths have no trailing slash. Globs support `*` (within a segment),
`?` (one character), and a whole-segment `**` (zero or more segments).
Braces, brackets, negation, escapes and empty/traversal segments are rejected.
Patterns are case-sensitive. In specifier patterns, `*` and `?` also match
slashes, so `cloudflare:*` includes scheme subpaths. Source globs retain segment
boundaries. R7 takes a JavaScript regex source, without flags.

## Worked seed configurations

These are the Pencil, Dial and Orbit seeds' rules. The matching plain JSON
files in `examples/` can be used as starting points. R3 admits `index.tsx`, and
all configurations inspect re-exports and dynamic imports. These deliberate
extensions over older checkers avoid syntax-dependent boundary bypasses.

### Pencil

```json
{
  "version": 1,
  "tsconfig": "tsconfig.app.json",
  "rules": {
    "R2": {
      "mounts": [
        "src/core/app/mountExtensions.client.ts",
        "src/core/app/mountExtensions.server.ts"
      ]
    },
    "R4": false,
    "R5": {
      "allowedDirectories": [
        "src/core/platform"
      ]
    },
    "R7": {
      "files": [
        "src/ext/index.client.*"
      ]
    },
    "R8": {
      "enabled": true,
      "files": [
        "src/ext/config.ts",
        "src/ext/local/**"
      ]
    }
  }
}
```

### Dial

```json
{
  "version": 1,
  "rules": {
    "R2": {
      "mounts": {
        "src/core/app/mount.server.ts": [
          "src/ext/index.server.ts"
        ],
        "src/core/app/public-mount.ts": [
          "src/ext/public-config.ts"
        ]
      }
    },
    "R3": {
      "exceptions": [
        "src/core/features/delivery/mail/index.ts"
      ]
    },
    "R4": {
      "specifiers": [],
      "specifierPrefixes": [
        "drizzle-orm"
      ],
      "clientModules": [
        "src/core/platform/db/client"
      ],
      "allowedFiles": [
        "**/repository.ts"
      ],
      "allowedDirectories": [
        "src/core/platform/db"
      ]
    },
    "R5": {
      "importScopes": [],
      "environmentScopes": [
        "**"
      ]
    },
    "R6": false
  }
}
```

Dial's environment scope covers all source, with the common AST environment
property forms. Comment/string occurrences of `context.env` are ignored. The
client-module rule uses resolved paths rather than matching text in a specifier.
Pinned mounts compare the exact resolved extension, not the written specifier.

### Orbit

```json
{
  "version": 1,
  "rules": {
    "R1": false,
    "R2": {
      "mounts": [
        "src/core/app/mounts/assistance.ts",
        "src/core/app/mounts/public-config.ts",
        "src/core/app/mounts/public-config.server.ts",
        "src/core/features/records/identity.ts",
        "src/core/features/records/repository.ts",
        "src/core/features/settings/repository.ts",
        "src/core/features/workbench/repository.ts"
      ]
    },
    "R3": false,
    "R4": {
      "allowedFiles": [
        "**/repository.ts",
        "**/*-repository.ts"
      ]
    },
    "R5": false,
    "R6": false
  }
}
```

## Adopting

1. Copy exactly these files byte for byte from `modules/boundary-checker/` to
   `vendor/base/modules/boundary-checker/`, preserving their relative paths.
   Do not copy tests or fixtures. This list is parsed by the adoption test:

<!-- copy-files:start -->
- `index.mjs`
- `index.d.mts`
- `cli.mjs`
- `config.mjs`
- `resolution.mjs`
- `paths.mjs`
- `walk.mjs`
- `reporter.mjs`
- `rules/client.mjs`
- `rules/database.mjs`
- `rules/evaluation.mjs`
- `rules/extensions.mjs`
- `rules/features.mjs`
- `rules/header.mjs`
- `rules/platform.mjs`
<!-- copy-files:end -->

2. Write `boundaries.json` at the seed root using its selected rules and
   tsconfig. Keep the seed's own TypeScript development dependency.
3. Add `"verify:boundaries": "node vendor/base/modules/boundary-checker/cli.mjs"`
   to `package.json` and append `pnpm run verify:boundaries` to the seed's
   `verify`. Run it against the actual seed, then run the seed's full verify.
4. Add this `edition.json` component with its real origin. `BASE_REPOSITORY`
   is the Base clone URL already named by the seed's other Base components.
   Replace `PIN` with the full committed Base revision containing the copied
   bytes:

```json
{
  "id": "runeditrun/boundary-checker",
  "role": "module",
  "source": {
    "kind": "local",
    "paths": ["vendor/base/modules/boundary-checker"],
    "origin": { "repository": "BASE_REPOSITORY", "revision": "PIN", "paths": ["modules/boundary-checker"] }
  }
}
```

5. Follow [onboarding's copy-record convention](../../onboarding/README.md#3-record-the-copy):

```sh
node scripts/edition-authoring/cli.mjs lock
node scripts/edition-authoring/cli.mjs check
node scripts/edition-authoring/cli.mjs record-base vendor/base/modules/boundary-checker modules/boundary-checker PIN
node scripts/edition-authoring/cli.mjs verify-base
```

   Add `verify-base` to the seed's `verify`. `record-base` records the copied
   subset and reports upstream files intentionally not copied, such as tests.
   Re-copy and refresh the full origin revision after upstream changes.
6. Delete the replaced local checker: Pencil's `scripts/verify-boundaries.mjs`,
   Dial's or Orbit's `scripts/check-boundaries.mjs`. Replace Vector's
   `tests/boundaries.test.ts` when it adopts the module. Remove its old script
   invocation so one checker owns the seed's selected rules.

No seed adoption is performed by publishing this module.

## Verification

Run `pnpm verify:boundary-checker` in Base. The Node tests exercise individual
rules, config failures, consumer TypeScript resolution, CLI exit codes and an
independent temporary seed copied using the Adopting list above. The script
also type-checks `index.d.mts` through a consumer using the reference's `tsc`.
To run the same tests against another TypeScript installation, set
`BOUNDARY_TYPESCRIPT` to that package's absolute directory.
