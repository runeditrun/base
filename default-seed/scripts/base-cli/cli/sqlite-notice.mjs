// Node 22 marks node:sqlite experimental and prints a warning when it loads.
// rer reads local SQLite on purpose (reset, export, import), so that one notice
// is dropped; every other warning still prints. Import it before node:sqlite
// loads: a static import of node:sqlite warns while its module graph links, so
// a process whose entry imports it statically preloads this with --import.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
 const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
 if (type === 'ExperimentalWarning' && /^SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
 return emitWarning.call(process, warning, ...rest);
};
