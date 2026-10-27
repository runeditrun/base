// Generated from Babel v7.29.8 (MIT); see README.md.
var OptionFlags = {
  AllowAwaitOutsideFunction: 1,
  AllowReturnOutsideFunction: 2,
  AllowNewTargetOutsideFunction: 4,
  AllowImportExportEverywhere: 8,
  AllowSuperOutsideMethod: 16,
  AllowYieldOutsideFunction: 32,
  AllowUndeclaredExports: 64,
  Ranges: 128,
  Tokens: 256,
  CreateImportExpressions: 512,
  CreateParenthesizedExpressions: 1024,
  ErrorRecovery: 2048,
  AttachComment: 4096,
  AnnexB: 8192
};
function createDefaultOptions() {
  return {
    sourceType: "script",
    sourceFilename: void 0,
    startIndex: 0,
    startColumn: 0,
    startLine: 1,
    allowAwaitOutsideFunction: !1,
    allowReturnOutsideFunction: !1,
    allowNewTargetOutsideFunction: !1,
    allowImportExportEverywhere: !1,
    allowSuperOutsideMethod: !1,
    allowUndeclaredExports: !1,
    allowYieldOutsideFunction: !1,
    plugins: [],
    strictMode: void 0,
    ranges: !1,
    tokens: !1,
    createImportExpressions: !1,
    createParenthesizedExpressions: !1,
    errorRecovery: !1,
    attachComment: !0,
    annexB: !0
  };
}
function getOptions(opts) {
  const options = createDefaultOptions();
  if (opts == null)
    return options;
  if (opts.annexB != null && opts.annexB !== !1)
    throw new Error("The `annexB` option can only be set to `false`.");
  for (const key of Object.keys(options))
    opts[key] != null && (options[key] = opts[key]);
  if (options.startLine === 1)
    opts.startIndex == null && options.startColumn > 0 ? options.startIndex = options.startColumn : opts.startColumn == null && options.startIndex > 0 && (options.startColumn = options.startIndex);
  else if ((opts.startColumn == null || opts.startIndex == null) && opts.startIndex != null)
    throw new Error("With a `startLine > 1` you must also specify `startIndex` and `startColumn`.");
  if (options.sourceType === "commonjs") {
    if (opts.allowAwaitOutsideFunction != null)
      throw new Error("The `allowAwaitOutsideFunction` option cannot be used with `sourceType: 'commonjs'`.");
    if (opts.allowReturnOutsideFunction != null)
      throw new Error("`sourceType: 'commonjs'` implies `allowReturnOutsideFunction: true`, please remove the `allowReturnOutsideFunction` option or use `sourceType: 'script'`.");
    if (opts.allowNewTargetOutsideFunction != null)
      throw new Error("`sourceType: 'commonjs'` implies `allowNewTargetOutsideFunction: true`, please remove the `allowNewTargetOutsideFunction` option or use `sourceType: 'script'`.");
  }
  return options;
}
export {
  OptionFlags,
  getOptions
};
