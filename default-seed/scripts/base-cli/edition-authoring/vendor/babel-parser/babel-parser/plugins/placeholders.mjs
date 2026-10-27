// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenLabelName, tt } from "../tokenizer/types.mjs";
import { ParseErrorEnum } from "../parse-error.mjs";
const PlaceholderErrors = ParseErrorEnum`placeholders`({
  ClassNameIsRequired: "A class name is required.",
  UnexpectedSpace: "Unexpected space in placeholder."
});
var stdin_default = (superClass) => class extends superClass {
  parsePlaceholder(expectedNode) {
    if (this.match(tt.placeholder)) {
      const node = this.startNode();
      return this.next(), this.assertNoSpace(), node.name = super.parseIdentifier(!0), this.assertNoSpace(), this.expect(tt.placeholder), this.finishPlaceholder(node, expectedNode);
    }
  }
  finishPlaceholder(node, expectedNode) {
    let placeholder = node;
    return (!placeholder.expectedNode || !placeholder.type) && (placeholder = this.finishNode(placeholder, "Placeholder")), placeholder.expectedNode = expectedNode, placeholder;
  }
  getTokenFromCode(code) {
    code === 37 && this.input.charCodeAt(this.state.pos + 1) === 37 ? this.finishOp(tt.placeholder, 2) : super.getTokenFromCode(code);
  }
  parseExprAtom(refExpressionErrors) {
    return this.parsePlaceholder("Expression") || super.parseExprAtom(refExpressionErrors);
  }
  parseIdentifier(liberal) {
    return this.parsePlaceholder("Identifier") || super.parseIdentifier(liberal);
  }
  checkReservedWord(word, startLoc, checkKeywords, isBinding) {
    word !== void 0 && super.checkReservedWord(word, startLoc, checkKeywords, isBinding);
  }
  cloneIdentifier(node) {
    const cloned = super.cloneIdentifier(node);
    return cloned.type === "Placeholder" && (cloned.expectedNode = node.expectedNode), cloned;
  }
  cloneStringLiteral(node) {
    return node.type === "Placeholder" ? this.cloneIdentifier(node) : super.cloneStringLiteral(node);
  }
  parseBindingAtom() {
    return this.parsePlaceholder("Pattern") || super.parseBindingAtom();
  }
  isValidLVal(type, disallowCallExpression, isParenthesized, binding) {
    return type === "Placeholder" || super.isValidLVal(type, disallowCallExpression, isParenthesized, binding);
  }
  toAssignable(node, isLHS) {
    node && node.type === "Placeholder" && node.expectedNode === "Expression" ? node.expectedNode = "Pattern" : super.toAssignable(node, isLHS);
  }
  chStartsBindingIdentifier(ch, pos) {
    if (super.chStartsBindingIdentifier(ch, pos))
      return !0;
    const next = this.nextTokenStart();
    return this.input.charCodeAt(next) === 37 && this.input.charCodeAt(next + 1) === 37;
  }
  verifyBreakContinue(node, isBreak) {
    node.label?.type !== "Placeholder" && super.verifyBreakContinue(node, isBreak);
  }
  parseExpressionStatement(node, expr) {
    if (expr.type !== "Placeholder" || expr.extra?.parenthesized)
      return super.parseExpressionStatement(node, expr);
    if (this.match(tt.colon)) {
      const stmt = node;
      return stmt.label = this.finishPlaceholder(expr, "Identifier"), this.next(), stmt.body = super.parseStatementOrSloppyAnnexBFunctionDeclaration(), this.finishNode(stmt, "LabeledStatement");
    }
    this.semicolon();
    const stmtPlaceholder = node;
    return stmtPlaceholder.name = expr.name, this.finishPlaceholder(stmtPlaceholder, "Statement");
  }
  parseBlock(allowDirectives, createNewLexicalScope, afterBlockParse) {
    return this.parsePlaceholder("BlockStatement") || super.parseBlock(allowDirectives, createNewLexicalScope, afterBlockParse);
  }
  parseFunctionId(requireId) {
    return this.parsePlaceholder("Identifier") || super.parseFunctionId(requireId);
  }
  parseClass(node, isStatement, optionalId) {
    const type = isStatement ? "ClassDeclaration" : "ClassExpression";
    this.next();
    const oldStrict = this.state.strict, placeholder = this.parsePlaceholder("Identifier");
    if (placeholder)
      if (this.match(tt._extends) || this.match(tt.placeholder) || this.match(tt.braceL))
        node.id = placeholder;
      else {
        if (optionalId || !isStatement)
          return node.id = null, node.body = this.finishPlaceholder(placeholder, "ClassBody"), this.finishNode(node, type);
        throw this.raise(PlaceholderErrors.ClassNameIsRequired, this.state.startLoc);
      }
    else
      this.parseClassId(node, isStatement, optionalId);
    return super.parseClassSuper(node), node.body = this.parsePlaceholder("ClassBody") || super.parseClassBody(!!node.superClass, oldStrict), this.finishNode(node, type);
  }
  parseExport(node, decorators) {
    const placeholder = this.parsePlaceholder("Identifier");
    if (!placeholder) return super.parseExport(node, decorators);
    const node2 = node;
    if (!this.isContextual(tt._from) && !this.match(tt.comma))
      return node2.specifiers = [], node2.source = null, node2.declaration = this.finishPlaceholder(placeholder, "Declaration"), this.finishNode(node2, "ExportNamedDeclaration");
    this.expectPlugin("exportDefaultFrom");
    const specifier = this.startNode();
    return specifier.exported = placeholder, node2.specifiers = [this.finishNode(specifier, "ExportDefaultSpecifier")], super.parseExport(node2, decorators);
  }
  isExportDefaultSpecifier() {
    if (this.match(tt._default)) {
      const next = this.nextTokenStart();
      if (this.isUnparsedContextual(next, "from") && this.input.startsWith(tokenLabelName(tt.placeholder), this.nextTokenStartSince(next + 4)))
        return !0;
    }
    return super.isExportDefaultSpecifier();
  }
  maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier) {
    return node.specifiers?.length ? !0 : super.maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier);
  }
  checkExport(node) {
    const {
      specifiers
    } = node;
    specifiers?.length && (node.specifiers = specifiers.filter((node2) => node2.exported.type === "Placeholder")), super.checkExport(node), node.specifiers = specifiers;
  }
  parseImport(node) {
    const placeholder = this.parsePlaceholder("Identifier");
    if (!placeholder) return super.parseImport(node);
    if (node.specifiers = [], !this.isContextual(tt._from) && !this.match(tt.comma))
      return node.source = this.finishPlaceholder(placeholder, "StringLiteral"), this.semicolon(), this.finishNode(node, "ImportDeclaration");
    const specifier = this.startNodeAtNode(placeholder);
    return specifier.local = placeholder, node.specifiers.push(this.finishNode(specifier, "ImportDefaultSpecifier")), this.eat(tt.comma) && (this.maybeParseStarImportSpecifier(node) || this.parseNamedImportSpecifiers(node)), this.expectContextual(tt._from), node.source = this.parseImportSource(), this.semicolon(), this.finishNode(node, "ImportDeclaration");
  }
  parseImportSource() {
    return this.parsePlaceholder("StringLiteral") || super.parseImportSource();
  }
  assertNoSpace() {
    this.state.start > this.offsetToSourcePos(this.state.lastTokEndLoc.index) && this.raise(PlaceholderErrors.UnexpectedSpace, this.state.lastTokEndLoc);
  }
};
export {
  stdin_default as default
};
