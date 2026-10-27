// Generated from Babel v7.29.8 (MIT); see README.md.
import { getOptions, OptionFlags } from "../options.mjs";
import StatementParser from "./statement.mjs";
import ScopeHandler from "../util/scope.mjs";
class Parser extends StatementParser {
  constructor(options, input, pluginsMap) {
    const normalizedOptions = getOptions(options);
    super(normalizedOptions, input), this.options = normalizedOptions, this.initializeScopes(), this.plugins = pluginsMap, this.filename = normalizedOptions.sourceFilename, this.startIndex = normalizedOptions.startIndex;
    let optionFlags = 0;
    normalizedOptions.allowAwaitOutsideFunction && (optionFlags |= OptionFlags.AllowAwaitOutsideFunction), normalizedOptions.allowReturnOutsideFunction && (optionFlags |= OptionFlags.AllowReturnOutsideFunction), normalizedOptions.allowImportExportEverywhere && (optionFlags |= OptionFlags.AllowImportExportEverywhere), normalizedOptions.allowSuperOutsideMethod && (optionFlags |= OptionFlags.AllowSuperOutsideMethod), normalizedOptions.allowUndeclaredExports && (optionFlags |= OptionFlags.AllowUndeclaredExports), normalizedOptions.allowNewTargetOutsideFunction && (optionFlags |= OptionFlags.AllowNewTargetOutsideFunction), normalizedOptions.allowYieldOutsideFunction && (optionFlags |= OptionFlags.AllowYieldOutsideFunction), normalizedOptions.ranges && (optionFlags |= OptionFlags.Ranges), normalizedOptions.tokens && (optionFlags |= OptionFlags.Tokens), normalizedOptions.createImportExpressions && (optionFlags |= OptionFlags.CreateImportExpressions), normalizedOptions.createParenthesizedExpressions && (optionFlags |= OptionFlags.CreateParenthesizedExpressions), normalizedOptions.errorRecovery && (optionFlags |= OptionFlags.ErrorRecovery), normalizedOptions.attachComment && (optionFlags |= OptionFlags.AttachComment), normalizedOptions.annexB && (optionFlags |= OptionFlags.AnnexB), this.optionFlags = optionFlags;
  }
  getScopeHandler() {
    return ScopeHandler;
  }
  parse() {
    this.enterInitialScopes();
    const file = this.startNode(), program = this.startNode();
    this.nextToken(), file.errors = null;
    const result = this.parseTopLevel(file, program);
    return result.errors = this.state.errors, result.comments.length = this.state.commentsLen, result;
  }
}
export {
  Parser as default
};
