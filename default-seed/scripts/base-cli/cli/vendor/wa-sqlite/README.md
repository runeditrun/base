# SQLite for Worker migration replay

The sync ES module and Wasm binary come from `dist/` in
[`@journeyapps/wa-sqlite@2.0.10`](https://www.npmjs.com/package/@journeyapps/wa-sqlite/v/2.0.10).
The glue uses its existing virtual temporary directory as the sandbox home
and omits the upstream simulated user home. The package builds SQLite 3.53.0
with FTS5 and is distributed under the MIT license in this directory. Only
the owner migration evidence module imports this engine.

To retrieve the sources, run `npm pack @journeyapps/wa-sqlite@2.0.10` and
extract the two named files from `package/dist/` and `package/LICENSE`.
The tarball has npm integrity
`sha512-6Wo5ZijOc4/6M9u+MDsJdW8zDCdrct/p+7LcG7S7CT5YKu42j6lshMfUvgtGYMaZeuH7rpQHULZupPTQFqbS0w==`.
