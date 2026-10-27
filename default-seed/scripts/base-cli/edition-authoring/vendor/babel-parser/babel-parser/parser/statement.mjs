// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenIsIdentifier, tokenIsKeywordOrIdentifier, tokenIsLoop, tokenIsTemplate, tt, getExportedToken } from "../tokenizer/types.mjs";
import ExpressionParser from "./expression.mjs";
import { Errors } from "../parse-error.mjs";
import { isIdentifierChar, isIdentifierStart } from "../util/identifier.mjs";
import { ScopeFlag, ClassElementType, BindingFlag } from "../util/scopeflags.mjs";
import { ExpressionErrors } from "./util.mjs";
import { ParamKind, functionFlags } from "../util/production-parameter.mjs";
import { newExpressionScope, newParameterDeclarationScope } from "../util/expression-scope.mjs";
import { OptionFlags } from "../options.mjs";
import { Token } from "../tokenizer/index.mjs";
import { createPositionWithColumnOffset } from "../util/location.mjs";
import { ParseBindingListFlags } from "./lval.mjs";
import { LoopLabelKind } from "../tokenizer/state.mjs";
const loopLabel = {
  kind: LoopLabelKind.Loop
}, switchLabel = {
  kind: LoopLabelKind.Switch
};
var ParseFunctionFlag = {
  Expression: 0,
  Declaration: 1,
  HangingDeclaration: 2,
  NullableId: 4,
  Async: 8
}, ParseStatementFlag = {
  StatementOnly: 0,
  AllowImportExport: 1,
  AllowDeclaration: 2,
  AllowFunctionDeclaration: 4,
  AllowLabeledFunction: 8
};
const loneSurrogate = /[\uD800-\uDFFF]/u, keywordRelationalOperator = /in(?:stanceof)?/y;
function babel7CompatTokens(tokens, input, startIndex) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], {
      type
    } = token;
    if (typeof type == "number") {
      if (type === tt.privateName) {
        const {
          loc,
          start,
          value,
          end
        } = token, hashEndPos = start + 1, hashEndLoc = createPositionWithColumnOffset(loc.start, 1);
        tokens.splice(i, 1, new Token({
          type: getExportedToken(tt.hash),
          value: "#",
          start,
          end: hashEndPos,
          startLoc: loc.start,
          endLoc: hashEndLoc
        }), new Token({
          type: getExportedToken(tt.name),
          value,
          start: hashEndPos,
          end,
          startLoc: hashEndLoc,
          endLoc: loc.end
        })), i++;
        continue;
      }
      if (tokenIsTemplate(type)) {
        const {
          loc,
          start,
          value,
          end
        } = token, backquoteEnd = start + 1, backquoteEndLoc = createPositionWithColumnOffset(loc.start, 1);
        let startToken;
        input.charCodeAt(start - startIndex) === 96 ? startToken = new Token({
          type: getExportedToken(tt.backQuote),
          value: "`",
          start,
          end: backquoteEnd,
          startLoc: loc.start,
          endLoc: backquoteEndLoc
        }) : startToken = new Token({
          type: getExportedToken(tt.braceR),
          value: "}",
          start,
          end: backquoteEnd,
          startLoc: loc.start,
          endLoc: backquoteEndLoc
        });
        let templateValue, templateElementEnd, templateElementEndLoc, endToken;
        type === tt.templateTail ? (templateElementEnd = end - 1, templateElementEndLoc = createPositionWithColumnOffset(loc.end, -1), templateValue = value === null ? null : value.slice(1, -1), endToken = new Token({
          type: getExportedToken(tt.backQuote),
          value: "`",
          start: templateElementEnd,
          end,
          startLoc: templateElementEndLoc,
          endLoc: loc.end
        })) : (templateElementEnd = end - 2, templateElementEndLoc = createPositionWithColumnOffset(loc.end, -2), templateValue = value === null ? null : value.slice(1, -2), endToken = new Token({
          type: getExportedToken(tt.dollarBraceL),
          value: "${",
          start: templateElementEnd,
          end,
          startLoc: templateElementEndLoc,
          endLoc: loc.end
        })), tokens.splice(i, 1, startToken, new Token({
          type: getExportedToken(tt.template),
          value: templateValue,
          start: backquoteEnd,
          end: templateElementEnd,
          startLoc: backquoteEndLoc,
          endLoc: templateElementEndLoc
        }), endToken), i += 2;
        continue;
      }
      token.type = getExportedToken(type);
    }
  }
  return tokens;
}
class StatementParser extends ExpressionParser {
  parseTopLevel(file, program) {
    return file.program = this.parseProgram(program, tt.eof, this.options.sourceType === "module" ? "module" : "script"), file.comments = this.comments, this.optionFlags & OptionFlags.Tokens && (file.tokens = babel7CompatTokens(this.tokens, this.input, this.startIndex)), this.finishNode(file, "File");
  }
  parseProgram(program, end, sourceType) {
    if (program.sourceType = sourceType, program.interpreter = this.parseInterpreterDirective(), this.parseBlockBody(program, !0, !0, end), this.inModule) {
      if (!(this.optionFlags & OptionFlags.AllowUndeclaredExports) && this.scope.undefinedExports.size > 0)
        for (const [localName, at] of Array.from(this.scope.undefinedExports))
          this.raise(Errors.ModuleExportUndefined, at, {
            localName
          });
      this.addExtra(program, "topLevelAwait", this.state.hasTopLevelAwait);
    }
    let finishedProgram;
    return end === tt.eof ? finishedProgram = this.finishNode(program, "Program") : finishedProgram = this.finishNodeAt(program, "Program", createPositionWithColumnOffset(this.state.startLoc, -1)), finishedProgram;
  }
  stmtToDirective(stmt) {
    const directive = this.castNodeTo(stmt, "Directive"), directiveLiteral = this.castNodeTo(stmt.expression, "DirectiveLiteral"), expressionValue = directiveLiteral.value, raw = this.input.slice(this.offsetToSourcePos(directiveLiteral.start), this.offsetToSourcePos(directiveLiteral.end)), val = directiveLiteral.value = raw.slice(1, -1);
    return this.addExtra(directiveLiteral, "raw", raw), this.addExtra(directiveLiteral, "rawValue", val), this.addExtra(directiveLiteral, "expressionValue", expressionValue), directive.value = directiveLiteral, delete stmt.expression, directive;
  }
  parseInterpreterDirective() {
    if (!this.match(tt.interpreterDirective))
      return null;
    const node = this.startNode();
    return node.value = this.state.value, this.next(), this.finishNode(node, "InterpreterDirective");
  }
  isLet() {
    return this.isContextual(tt._let) ? this.hasFollowingBindingAtom() : !1;
  }
  isUsing() {
    return this.isContextual(tt._using) ? this.nextTokenIsIdentifierOnSameLine() : !1;
  }
  isForUsing() {
    if (!this.isContextual(tt._using))
      return !1;
    const next = this.nextTokenInLineStart(), nextCh = this.codePointAtPos(next);
    if (this.isUnparsedContextual(next, "of")) {
      const nextCharAfterOf = this.lookaheadCharCodeSince(next + 2);
      if (nextCharAfterOf !== 61 && nextCharAfterOf !== 58 && nextCharAfterOf !== 59)
        return !1;
    }
    return !!(this.chStartsBindingIdentifier(nextCh, next) || this.isUnparsedContextual(next, "void"));
  }
  nextTokenIsIdentifierOnSameLine() {
    const next = this.nextTokenInLineStart(), nextCh = this.codePointAtPos(next);
    return this.chStartsBindingIdentifier(nextCh, next);
  }
  isAwaitUsing() {
    if (!this.isContextual(tt._await))
      return !1;
    let next = this.nextTokenInLineStart();
    if (this.isUnparsedContextual(next, "using")) {
      next = this.nextTokenInLineStartSince(next + 5);
      const nextCh = this.codePointAtPos(next);
      if (this.chStartsBindingIdentifier(nextCh, next))
        return !0;
    }
    return !1;
  }
  chStartsBindingIdentifier(ch, pos) {
    if (isIdentifierStart(ch)) {
      if (keywordRelationalOperator.lastIndex = pos, keywordRelationalOperator.test(this.input)) {
        const endCh = this.codePointAtPos(keywordRelationalOperator.lastIndex);
        if (!isIdentifierChar(endCh) && endCh !== 92)
          return !1;
      }
      return !0;
    } else return ch === 92;
  }
  chStartsBindingPattern(ch) {
    return ch === 91 || ch === 123;
  }
  hasFollowingBindingAtom() {
    const next = this.nextTokenStart(), nextCh = this.codePointAtPos(next);
    return this.chStartsBindingPattern(nextCh) || this.chStartsBindingIdentifier(nextCh, next);
  }
  hasInLineFollowingBindingIdentifierOrBrace() {
    const next = this.nextTokenInLineStart(), nextCh = this.codePointAtPos(next);
    return nextCh === 123 || this.chStartsBindingIdentifier(nextCh, next);
  }
  allowsUsing() {
    return (this.scope.inModule || !this.scope.inTopLevel) && !this.scope.inBareCaseStatement;
  }
  parseModuleItem() {
    return this.parseStatementLike(ParseStatementFlag.AllowImportExport | ParseStatementFlag.AllowDeclaration | ParseStatementFlag.AllowFunctionDeclaration | ParseStatementFlag.AllowLabeledFunction);
  }
  parseStatementListItem() {
    return this.parseStatementLike(ParseStatementFlag.AllowDeclaration | ParseStatementFlag.AllowFunctionDeclaration | (!this.options.annexB || this.state.strict ? 0 : ParseStatementFlag.AllowLabeledFunction));
  }
  parseStatementOrSloppyAnnexBFunctionDeclaration(allowLabeledFunction = !1) {
    let flags = ParseStatementFlag.StatementOnly;
    return this.options.annexB && !this.state.strict && (flags |= ParseStatementFlag.AllowFunctionDeclaration, allowLabeledFunction && (flags |= ParseStatementFlag.AllowLabeledFunction)), this.parseStatementLike(flags);
  }
  parseStatement() {
    return this.parseStatementLike(ParseStatementFlag.StatementOnly);
  }
  parseStatementLike(flags) {
    let decorators = null;
    return this.match(tt.at) && (decorators = this.parseDecorators(!0)), this.parseStatementContent(flags, decorators);
  }
  parseStatementContent(flags, decorators) {
    const startType = this.state.type, node = this.startNode(), allowDeclaration = !!(flags & ParseStatementFlag.AllowDeclaration), allowFunctionDeclaration = !!(flags & ParseStatementFlag.AllowFunctionDeclaration), topLevel = flags & ParseStatementFlag.AllowImportExport;
    switch (startType) {
      case tt._break:
        return this.parseBreakContinueStatement(node, !0);
      case tt._continue:
        return this.parseBreakContinueStatement(node, !1);
      case tt._debugger:
        return this.parseDebuggerStatement(node);
      case tt._do:
        return this.parseDoWhileStatement(node);
      case tt._for:
        return this.parseForStatement(node);
      case tt._function:
        if (this.lookaheadCharCode() === 46) break;
        return allowFunctionDeclaration || this.raise(this.state.strict ? Errors.StrictFunction : this.options.annexB ? Errors.SloppyFunctionAnnexB : Errors.SloppyFunction, this.state.startLoc), this.parseFunctionStatement(node, !1, !allowDeclaration && allowFunctionDeclaration);
      case tt._class:
        return allowDeclaration || this.unexpected(), this.parseClass(this.maybeTakeDecorators(decorators, node), !0);
      case tt._if:
        return this.parseIfStatement(node);
      case tt._return:
        return this.parseReturnStatement(node);
      case tt._switch:
        return this.parseSwitchStatement(node);
      case tt._throw:
        return this.parseThrowStatement(node);
      case tt._try:
        return this.parseTryStatement(node);
      case tt._await:
        if (this.isAwaitUsing())
          return this.allowsUsing() ? allowDeclaration ? this.recordAwaitIfAllowed() || this.raise(Errors.AwaitUsingNotInAsyncContext, node) : this.raise(Errors.UnexpectedLexicalDeclaration, node) : this.raise(Errors.UnexpectedUsingDeclaration, node), this.next(), this.parseVarStatement(node, "await using");
        break;
      case tt._using:
        if (this.state.containsEsc || !this.hasInLineFollowingBindingIdentifierOrBrace())
          break;
        return this.allowsUsing() ? allowDeclaration || this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc) : this.raise(Errors.UnexpectedUsingDeclaration, this.state.startLoc), this.parseVarStatement(node, "using");
      case tt._let: {
        if (this.state.containsEsc)
          break;
        const next = this.nextTokenStart(), nextCh = this.codePointAtPos(next);
        if (nextCh !== 91 && (!allowDeclaration && this.hasFollowingLineBreak() || !this.chStartsBindingIdentifier(nextCh, next) && nextCh !== 123))
          break;
      }
      case tt._const:
        allowDeclaration || this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc);
      case tt._var: {
        const kind = this.state.value;
        return this.parseVarStatement(node, kind);
      }
      case tt._while:
        return this.parseWhileStatement(node);
      case tt._with:
        return this.parseWithStatement(node);
      case tt.braceL:
        return this.parseBlock();
      case tt.semi:
        return this.parseEmptyStatement(node);
      case tt._import: {
        const nextTokenCharCode = this.lookaheadCharCode();
        if (nextTokenCharCode === 40 || nextTokenCharCode === 46)
          break;
      }
      case tt._export: {
        !(this.optionFlags & OptionFlags.AllowImportExportEverywhere) && !topLevel && this.raise(Errors.UnexpectedImportExport, this.state.startLoc), this.next();
        let result;
        return startType === tt._import ? result = this.parseImport(node) : result = this.parseExport(node, decorators), this.assertModuleNodeAllowed(result), result;
      }
      default:
        if (this.isAsyncFunction())
          return allowDeclaration || this.raise(Errors.AsyncFunctionInSingleStatementContext, this.state.startLoc), this.next(), this.parseFunctionStatement(node, !0, !allowDeclaration && allowFunctionDeclaration);
    }
    const maybeName = this.state.value, expr = this.parseExpression();
    return tokenIsIdentifier(startType) && expr.type === "Identifier" && this.eat(tt.colon) ? this.parseLabeledStatement(node, maybeName, expr, flags) : this.parseExpressionStatement(node, expr, decorators);
  }
  assertModuleNodeAllowed(node) {
    !(this.optionFlags & OptionFlags.AllowImportExportEverywhere) && !this.inModule && this.raise(Errors.ImportOutsideModule, node);
  }
  decoratorsEnabledBeforeExport() {
    return this.hasPlugin("decorators-legacy") ? !0 : this.hasPlugin("decorators") && this.getPluginOption("decorators", "decoratorsBeforeExport") !== !1;
  }
  maybeTakeDecorators(maybeDecorators, classNode, exportNode) {
    return maybeDecorators && (classNode.decorators?.length ? (typeof this.getPluginOption("decorators", "decoratorsBeforeExport") != "boolean" && this.raise(Errors.DecoratorsBeforeAfterExport, classNode.decorators[0]), classNode.decorators.unshift(...maybeDecorators)) : classNode.decorators = maybeDecorators, this.resetStartLocationFromNode(classNode, maybeDecorators[0]), exportNode && this.resetStartLocationFromNode(exportNode, classNode)), classNode;
  }
  canHaveLeadingDecorator() {
    return this.match(tt._class);
  }
  parseDecorators(allowExport) {
    const decorators = [];
    do
      decorators.push(this.parseDecorator());
    while (this.match(tt.at));
    if (this.match(tt._export))
      allowExport || this.unexpected(), this.decoratorsEnabledBeforeExport() || this.raise(Errors.DecoratorExportClass, this.state.startLoc);
    else if (!this.canHaveLeadingDecorator())
      throw this.raise(Errors.UnexpectedLeadingDecorator, this.state.startLoc);
    return decorators;
  }
  parseDecorator() {
    this.expectOnePlugin(["decorators", "decorators-legacy"]);
    const node = this.startNode();
    if (this.next(), this.hasPlugin("decorators")) {
      const startLoc = this.state.startLoc;
      let expr;
      if (this.match(tt.parenL)) {
        const startLoc2 = this.state.startLoc;
        this.next(), expr = this.parseExpression(), this.expect(tt.parenR), expr = this.wrapParenthesis(startLoc2, expr);
        const paramsStartLoc = this.state.startLoc;
        node.expression = this.parseMaybeDecoratorArguments(expr, startLoc2), this.getPluginOption("decorators", "allowCallParenthesized") === !1 && node.expression !== expr && this.raise(Errors.DecoratorArgumentsOutsideParentheses, paramsStartLoc);
      } else {
        for (expr = this.parseIdentifier(!1); this.eat(tt.dot); ) {
          const node2 = this.startNodeAt(startLoc);
          node2.object = expr, this.match(tt.privateName) ? (this.classScope.usePrivateName(this.state.value, this.state.startLoc), node2.property = this.parsePrivateName()) : node2.property = this.parseIdentifier(!0), node2.computed = !1, expr = this.finishNode(node2, "MemberExpression");
        }
        node.expression = this.parseMaybeDecoratorArguments(expr, startLoc);
      }
    } else
      node.expression = this.parseExprSubscripts();
    return this.finishNode(node, "Decorator");
  }
  parseMaybeDecoratorArguments(expr, startLoc) {
    if (this.eat(tt.parenL)) {
      const node = this.startNodeAt(startLoc);
      return node.callee = expr, node.arguments = this.parseCallExpressionArguments(), this.toReferencedList(node.arguments), this.finishNode(node, "CallExpression");
    }
    return expr;
  }
  parseBreakContinueStatement(node, isBreak) {
    return this.next(), this.isLineTerminator() ? node.label = null : (node.label = this.parseIdentifier(), this.semicolon()), this.verifyBreakContinue(node, isBreak), this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
  }
  verifyBreakContinue(node, isBreak) {
    let i;
    for (i = 0; i < this.state.labels.length; ++i) {
      const lab = this.state.labels[i];
      if ((node.label == null || lab.name === node.label.name) && (lab.kind != null && (isBreak || lab.kind === LoopLabelKind.Loop) || node.label && isBreak))
        break;
    }
    if (i === this.state.labels.length) {
      const type = isBreak ? "BreakStatement" : "ContinueStatement";
      this.raise(Errors.IllegalBreakContinue, node, {
        type
      });
    }
  }
  parseDebuggerStatement(node) {
    return this.next(), this.semicolon(), this.finishNode(node, "DebuggerStatement");
  }
  parseHeaderExpression() {
    this.expect(tt.parenL);
    const val = this.parseExpression();
    return this.expect(tt.parenR), val;
  }
  parseDoWhileStatement(node) {
    return this.next(), this.state.labels.push(loopLabel), node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement()), this.state.labels.pop(), this.expect(tt._while), node.test = this.parseHeaderExpression(), this.eat(tt.semi), this.finishNode(node, "DoWhileStatement");
  }
  parseForStatement(node) {
    this.next(), this.state.labels.push(loopLabel);
    let awaitAt = null;
    if (this.isContextual(tt._await) && this.recordAwaitIfAllowed() && (awaitAt = this.state.startLoc, this.next()), this.scope.enter(ScopeFlag.OTHER), this.expect(tt.parenL), this.match(tt.semi))
      return awaitAt !== null && this.unexpected(awaitAt), this.parseFor(node, null);
    const startsWithLet = this.isContextual(tt._let);
    {
      const startsWithAwaitUsing = this.isAwaitUsing(), starsWithUsingDeclaration = startsWithAwaitUsing || this.isForUsing(), isLetOrUsing = startsWithLet && this.hasFollowingBindingAtom() || starsWithUsingDeclaration;
      if (this.match(tt._var) || this.match(tt._const) || isLetOrUsing) {
        const initNode = this.startNode();
        let kind;
        startsWithAwaitUsing ? (kind = "await using", this.recordAwaitIfAllowed() || this.raise(Errors.AwaitUsingNotInAsyncContext, this.state.startLoc), this.next()) : kind = this.state.value, this.next(), this.parseVar(initNode, !0, kind);
        const init2 = this.finishNode(initNode, "VariableDeclaration"), isForIn = this.match(tt._in);
        return isForIn && starsWithUsingDeclaration && this.raise(Errors.ForInUsing, init2), (isForIn || this.isContextual(tt._of)) && init2.declarations.length === 1 ? this.parseForIn(node, init2, awaitAt) : (awaitAt !== null && this.unexpected(awaitAt), this.parseFor(node, init2));
      }
    }
    const startsWithAsync = this.isContextual(tt._async), refExpressionErrors = new ExpressionErrors(), init = this.parseExpression(!0, refExpressionErrors), isForOf = this.isContextual(tt._of);
    if (isForOf && (startsWithLet && this.raise(Errors.ForOfLet, init), awaitAt === null && startsWithAsync && init.type === "Identifier" && this.raise(Errors.ForOfAsync, init)), isForOf || this.match(tt._in)) {
      this.checkDestructuringPrivate(refExpressionErrors), this.toAssignable(init, !0);
      const type = isForOf ? "ForOfStatement" : "ForInStatement";
      return this.checkLVal(init, {
        type
      }), this.parseForIn(node, init, awaitAt);
    } else
      this.checkExpressionErrors(refExpressionErrors, !0);
    return awaitAt !== null && this.unexpected(awaitAt), this.parseFor(node, init);
  }
  parseFunctionStatement(node, isAsync, isHangingDeclaration) {
    return this.next(), this.parseFunction(node, ParseFunctionFlag.Declaration | (isHangingDeclaration ? ParseFunctionFlag.HangingDeclaration : 0) | (isAsync ? ParseFunctionFlag.Async : 0));
  }
  parseIfStatement(node) {
    return this.next(), node.test = this.parseHeaderExpression(), node.consequent = this.parseStatementOrSloppyAnnexBFunctionDeclaration(), node.alternate = this.eat(tt._else) ? this.parseStatementOrSloppyAnnexBFunctionDeclaration() : null, this.finishNode(node, "IfStatement");
  }
  parseReturnStatement(node) {
    return this.prodParam.hasReturn || this.raise(Errors.IllegalReturn, this.state.startLoc), this.next(), this.isLineTerminator() ? node.argument = null : (node.argument = this.parseExpression(), this.semicolon()), this.finishNode(node, "ReturnStatement");
  }
  parseSwitchStatement(node) {
    this.next(), node.discriminant = this.parseHeaderExpression();
    const cases = node.cases = [];
    this.expect(tt.braceL), this.state.labels.push(switchLabel), this.scope.enter(ScopeFlag.SWITCH);
    let cur;
    for (let sawDefault; !this.match(tt.braceR); )
      if (this.match(tt._case) || this.match(tt._default)) {
        const isCase = this.match(tt._case);
        cur && this.finishNode(cur, "SwitchCase"), cases.push(cur = this.startNode()), cur.consequent = [], this.next(), isCase ? cur.test = this.parseExpression() : (sawDefault && this.raise(Errors.MultipleDefaultsInSwitch, this.state.lastTokStartLoc), sawDefault = !0, cur.test = null), this.expect(tt.colon);
      } else
        cur ? cur.consequent.push(this.parseStatementListItem()) : this.unexpected();
    return this.scope.exit(), cur && this.finishNode(cur, "SwitchCase"), this.next(), this.state.labels.pop(), this.finishNode(node, "SwitchStatement");
  }
  parseThrowStatement(node) {
    return this.next(), this.hasPrecedingLineBreak() && this.raise(Errors.NewlineAfterThrow, this.state.lastTokEndLoc), node.argument = this.parseExpression(), this.semicolon(), this.finishNode(node, "ThrowStatement");
  }
  parseCatchClauseParam() {
    const param = this.parseBindingAtom();
    return this.scope.enter(this.options.annexB && param.type === "Identifier" ? ScopeFlag.SIMPLE_CATCH : ScopeFlag.OTHER), this.checkLVal(param, {
      type: "CatchClause"
    }, BindingFlag.TYPE_CATCH_PARAM), param;
  }
  parseTryStatement(node) {
    if (this.next(), node.block = this.parseBlock(), node.handler = null, this.match(tt._catch)) {
      const clause = this.startNode();
      this.next(), this.match(tt.parenL) ? (this.expect(tt.parenL), clause.param = this.parseCatchClauseParam(), this.expect(tt.parenR)) : (clause.param = null, this.scope.enter(ScopeFlag.OTHER)), clause.body = this.withSmartMixTopicForbiddingContext(() => this.parseBlock(!1, !1)), this.scope.exit(), node.handler = this.finishNode(clause, "CatchClause");
    }
    return node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null, !node.handler && !node.finalizer && this.raise(Errors.NoCatchOrFinally, node), this.finishNode(node, "TryStatement");
  }
  parseVarStatement(node, kind, allowMissingInitializer = !1) {
    return this.next(), this.parseVar(node, !1, kind, allowMissingInitializer), this.semicolon(), this.finishNode(node, "VariableDeclaration");
  }
  parseWhileStatement(node) {
    return this.next(), node.test = this.parseHeaderExpression(), this.state.labels.push(loopLabel), node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement()), this.state.labels.pop(), this.finishNode(node, "WhileStatement");
  }
  parseWithStatement(node) {
    return this.state.strict && this.raise(Errors.StrictWith, this.state.startLoc), this.next(), node.object = this.parseHeaderExpression(), node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement()), this.finishNode(node, "WithStatement");
  }
  parseEmptyStatement(node) {
    return this.next(), this.finishNode(node, "EmptyStatement");
  }
  parseLabeledStatement(node, maybeName, expr, flags) {
    for (const label of this.state.labels)
      label.name === maybeName && this.raise(Errors.LabelRedeclaration, expr, {
        labelName: maybeName
      });
    const kind = tokenIsLoop(this.state.type) ? LoopLabelKind.Loop : this.match(tt._switch) ? LoopLabelKind.Switch : null;
    for (let i = this.state.labels.length - 1; i >= 0; i--) {
      const label = this.state.labels[i];
      if (label.statementStart === node.start)
        label.statementStart = this.sourceToOffsetPos(this.state.start), label.kind = kind;
      else
        break;
    }
    return this.state.labels.push({
      name: maybeName,
      kind,
      statementStart: this.sourceToOffsetPos(this.state.start)
    }), node.body = flags & ParseStatementFlag.AllowLabeledFunction ? this.parseStatementOrSloppyAnnexBFunctionDeclaration(!0) : this.parseStatement(), this.state.labels.pop(), node.label = expr, this.finishNode(node, "LabeledStatement");
  }
  parseExpressionStatement(node, expr, decorators) {
    return node.expression = expr, this.semicolon(), this.finishNode(node, "ExpressionStatement");
  }
  parseBlock(allowDirectives = !1, createNewLexicalScope = !0, afterBlockParse) {
    const node = this.startNode();
    return allowDirectives && this.state.strictErrors.clear(), this.expect(tt.braceL), createNewLexicalScope && this.scope.enter(ScopeFlag.OTHER), this.parseBlockBody(node, allowDirectives, !1, tt.braceR, afterBlockParse), createNewLexicalScope && this.scope.exit(), this.finishNode(node, "BlockStatement");
  }
  isValidDirective(stmt) {
    return stmt.type === "ExpressionStatement" && stmt.expression.type === "StringLiteral" && !stmt.expression.extra.parenthesized;
  }
  parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse) {
    const body = node.body = [], directives = node.directives = [];
    this.parseBlockOrModuleBlockBody(body, allowDirectives ? directives : void 0, topLevel, end, afterBlockParse);
  }
  parseBlockOrModuleBlockBody(body, directives, topLevel, end, afterBlockParse) {
    const oldStrict = this.state.strict;
    let hasStrictModeDirective = !1, parsedNonDirective = !1;
    for (; !this.match(end); ) {
      const stmt = topLevel ? this.parseModuleItem() : this.parseStatementListItem();
      if (directives && !parsedNonDirective) {
        if (this.isValidDirective(stmt)) {
          const directive = this.stmtToDirective(stmt);
          directives.push(directive), !hasStrictModeDirective && directive.value.value === "use strict" && (hasStrictModeDirective = !0, this.setStrict(!0));
          continue;
        }
        parsedNonDirective = !0, this.state.strictErrors.clear();
      }
      body.push(stmt);
    }
    afterBlockParse?.call(this, hasStrictModeDirective), oldStrict || this.setStrict(!1), this.next();
  }
  parseFor(node, init) {
    return node.init = init, this.semicolon(!1), node.test = this.match(tt.semi) ? null : this.parseExpression(), this.semicolon(!1), node.update = this.match(tt.parenR) ? null : this.parseExpression(), this.expect(tt.parenR), node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement()), this.scope.exit(), this.state.labels.pop(), this.finishNode(node, "ForStatement");
  }
  parseForIn(node, init, awaitAt) {
    const isForIn = this.match(tt._in);
    return this.next(), isForIn ? awaitAt !== null && this.unexpected(awaitAt) : node.await = awaitAt !== null, init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || !this.options.annexB || this.state.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier") && this.raise(Errors.ForInOfLoopInitializer, init, {
      type: isForIn ? "ForInStatement" : "ForOfStatement"
    }), init.type === "AssignmentPattern" && this.raise(Errors.InvalidLhs, init, {
      ancestor: {
        type: "ForStatement"
      }
    }), node.left = init, node.right = isForIn ? this.parseExpression() : this.parseMaybeAssignAllowIn(), this.expect(tt.parenR), node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement()), this.scope.exit(), this.state.labels.pop(), this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
  }
  parseVar(node, isFor, kind, allowMissingInitializer = !1) {
    const declarations = node.declarations = [];
    for (node.kind = kind; ; ) {
      const decl = this.startNode();
      if (this.parseVarId(decl, kind), decl.init = this.eat(tt.eq) ? isFor ? this.parseMaybeAssignDisallowIn() : this.parseMaybeAssignAllowIn() : null, decl.init === null && !allowMissingInitializer && (decl.id.type !== "Identifier" && !(isFor && (this.match(tt._in) || this.isContextual(tt._of))) ? this.raise(Errors.DeclarationMissingInitializer, this.state.lastTokEndLoc, {
        kind: "destructuring"
      }) : (kind === "const" || kind === "using" || kind === "await using") && !(this.match(tt._in) || this.isContextual(tt._of)) && this.raise(Errors.DeclarationMissingInitializer, this.state.lastTokEndLoc, {
        kind
      })), declarations.push(this.finishNode(decl, "VariableDeclarator")), !this.eat(tt.comma)) break;
    }
    return node;
  }
  parseVarId(decl, kind) {
    const id = this.parseBindingAtom();
    kind === "using" || kind === "await using" ? (id.type === "ArrayPattern" || id.type === "ObjectPattern") && this.raise(Errors.UsingDeclarationHasBindingPattern, id.loc.start) : id.type === "VoidPattern" && this.raise(Errors.UnexpectedVoidPattern, id.loc.start), this.checkLVal(id, {
      type: "VariableDeclarator"
    }, kind === "var" ? BindingFlag.TYPE_VAR : BindingFlag.TYPE_LEXICAL), decl.id = id;
  }
  parseAsyncFunctionExpression(node) {
    return this.parseFunction(node, ParseFunctionFlag.Async);
  }
  parseFunction(node, flags = ParseFunctionFlag.Expression) {
    const hangingDeclaration = flags & ParseFunctionFlag.HangingDeclaration, isDeclaration = !!(flags & ParseFunctionFlag.Declaration), requireId = isDeclaration && !(flags & ParseFunctionFlag.NullableId), isAsync = !!(flags & ParseFunctionFlag.Async);
    this.initFunction(node, isAsync), this.match(tt.star) && (hangingDeclaration && this.raise(Errors.GeneratorInSingleStatementContext, this.state.startLoc), this.next(), node.generator = !0), isDeclaration && (node.id = this.parseFunctionId(requireId));
    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    return this.state.maybeInArrowParameters = !1, this.scope.enter(ScopeFlag.FUNCTION), this.prodParam.enter(functionFlags(isAsync, node.generator)), isDeclaration || (node.id = this.parseFunctionId()), this.parseFunctionParams(node, !1), this.withSmartMixTopicForbiddingContext(() => {
      this.parseFunctionBodyAndFinish(node, isDeclaration ? "FunctionDeclaration" : "FunctionExpression");
    }), this.prodParam.exit(), this.scope.exit(), isDeclaration && !hangingDeclaration && this.registerFunctionStatementId(node), this.state.maybeInArrowParameters = oldMaybeInArrowParameters, node;
  }
  parseFunctionId(requireId) {
    return requireId || tokenIsIdentifier(this.state.type) ? this.parseIdentifier() : null;
  }
  parseFunctionParams(node, isConstructor) {
    this.expect(tt.parenL), this.expressionScope.enter(newParameterDeclarationScope()), node.params = this.parseBindingList(tt.parenR, 41, ParseBindingListFlags.IS_FUNCTION_PARAMS | (isConstructor ? ParseBindingListFlags.IS_CONSTRUCTOR_PARAMS : 0)), this.expressionScope.exit();
  }
  registerFunctionStatementId(node) {
    node.id && this.scope.declareName(node.id.name, !this.options.annexB || this.state.strict || node.generator || node.async ? this.scope.treatFunctionsAsVar ? BindingFlag.TYPE_VAR : BindingFlag.TYPE_LEXICAL : BindingFlag.TYPE_FUNCTION, node.id.loc.start);
  }
  parseClass(node, isStatement, optionalId) {
    this.next();
    const oldStrict = this.state.strict;
    return this.state.strict = !0, this.parseClassId(node, isStatement, optionalId), this.parseClassSuper(node), node.body = this.parseClassBody(!!node.superClass, oldStrict), this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
  }
  isClassProperty() {
    return this.match(tt.eq) || this.match(tt.semi) || this.match(tt.braceR);
  }
  isClassMethod() {
    return this.match(tt.parenL);
  }
  nameIsConstructor(key) {
    return key.type === "Identifier" && key.name === "constructor" || key.type === "StringLiteral" && key.value === "constructor";
  }
  isNonstaticConstructor(method) {
    return !method.computed && !method.static && this.nameIsConstructor(method.key);
  }
  parseClassBody(hadSuperClass, oldStrict) {
    this.classScope.enter();
    const state = {
      hadConstructor: !1,
      hadSuperClass
    };
    let decorators = [];
    const classBody = this.startNode();
    if (classBody.body = [], this.expect(tt.braceL), this.withSmartMixTopicForbiddingContext(() => {
      for (; !this.match(tt.braceR); ) {
        if (this.eat(tt.semi)) {
          if (decorators.length > 0)
            throw this.raise(Errors.DecoratorSemicolon, this.state.lastTokEndLoc);
          continue;
        }
        if (this.match(tt.at)) {
          decorators.push(this.parseDecorator());
          continue;
        }
        const member = this.startNode();
        decorators.length && (member.decorators = decorators, this.resetStartLocationFromNode(member, decorators[0]), decorators = []), this.parseClassMember(classBody, member, state), member.kind === "constructor" && member.decorators && member.decorators.length > 0 && this.raise(Errors.DecoratorConstructor, member);
      }
    }), this.state.strict = oldStrict, this.next(), decorators.length)
      throw this.raise(Errors.TrailingDecorator, this.state.startLoc);
    return this.classScope.exit(), this.finishNode(classBody, "ClassBody");
  }
  parseClassMemberFromModifier(classBody, member) {
    const key = this.parseIdentifier(!0);
    if (this.isClassMethod()) {
      const method = member;
      return method.kind = "method", method.computed = !1, method.key = key, method.static = !1, this.pushClassMethod(classBody, method, !1, !1, !1, !1), !0;
    } else if (this.isClassProperty()) {
      const prop = member;
      return prop.computed = !1, prop.key = key, prop.static = !1, classBody.body.push(this.parseClassProperty(prop)), !0;
    }
    return this.resetPreviousNodeTrailingComments(key), !1;
  }
  parseClassMember(classBody, member, state) {
    const isStatic = this.isContextual(tt._static);
    if (isStatic) {
      if (this.parseClassMemberFromModifier(classBody, member))
        return;
      if (this.eat(tt.braceL)) {
        this.parseClassStaticBlock(classBody, member);
        return;
      }
    }
    this.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
  }
  parseClassMemberWithIsStatic(classBody, member, state, isStatic) {
    const publicMethod = member, privateMethod = member, publicProp = member, privateProp = member, accessorProp = member, method = publicMethod, publicMember = publicMethod;
    if (member.static = isStatic, this.parsePropertyNamePrefixOperator(member), this.eat(tt.star)) {
      method.kind = "method";
      const isPrivateName = this.match(tt.privateName);
      if (this.parseClassElementName(method), this.parsePostMemberNameModifiers(method), isPrivateName) {
        this.pushClassPrivateMethod(classBody, privateMethod, !0, !1);
        return;
      }
      this.isNonstaticConstructor(publicMethod) && this.raise(Errors.ConstructorIsGenerator, publicMethod.key), this.pushClassMethod(classBody, publicMethod, !0, !1, !1, !1);
      return;
    }
    const isContextual = !this.state.containsEsc && tokenIsIdentifier(this.state.type), key = this.parseClassElementName(member), maybeContextualKw = isContextual ? key.name : null, isPrivate = this.isPrivateName(key), maybeQuestionTokenStartLoc = this.state.startLoc;
    if (this.parsePostMemberNameModifiers(publicMember), this.isClassMethod()) {
      if (method.kind = "method", isPrivate) {
        this.pushClassPrivateMethod(classBody, privateMethod, !1, !1);
        return;
      }
      const isConstructor = this.isNonstaticConstructor(publicMethod);
      let allowsDirectSuper = !1;
      isConstructor && (publicMethod.kind = "constructor", state.hadConstructor && !this.hasPlugin("typescript") && this.raise(Errors.DuplicateConstructor, key), isConstructor && this.hasPlugin("typescript") && member.override && this.raise(Errors.OverrideOnConstructor, key), state.hadConstructor = !0, allowsDirectSuper = state.hadSuperClass), this.pushClassMethod(classBody, publicMethod, !1, !1, isConstructor, allowsDirectSuper);
    } else if (this.isClassProperty())
      isPrivate ? this.pushClassPrivateProperty(classBody, privateProp) : this.pushClassProperty(classBody, publicProp);
    else if (maybeContextualKw === "async" && !this.isLineTerminator()) {
      this.resetPreviousNodeTrailingComments(key);
      const isGenerator = this.eat(tt.star);
      publicMember.optional && this.unexpected(maybeQuestionTokenStartLoc), method.kind = "method";
      const isPrivate2 = this.match(tt.privateName);
      this.parseClassElementName(method), this.parsePostMemberNameModifiers(publicMember), isPrivate2 ? this.pushClassPrivateMethod(classBody, privateMethod, isGenerator, !0) : (this.isNonstaticConstructor(publicMethod) && this.raise(Errors.ConstructorIsAsync, publicMethod.key), this.pushClassMethod(classBody, publicMethod, isGenerator, !0, !1, !1));
    } else if ((maybeContextualKw === "get" || maybeContextualKw === "set") && !(this.match(tt.star) && this.isLineTerminator())) {
      this.resetPreviousNodeTrailingComments(key), method.kind = maybeContextualKw;
      const isPrivate2 = this.match(tt.privateName);
      this.parseClassElementName(publicMethod), isPrivate2 ? this.pushClassPrivateMethod(classBody, privateMethod, !1, !1) : (this.isNonstaticConstructor(publicMethod) && this.raise(Errors.ConstructorIsAccessor, publicMethod.key), this.pushClassMethod(classBody, publicMethod, !1, !1, !1, !1)), this.checkGetterSetterParams(publicMethod);
    } else if (maybeContextualKw === "accessor" && !this.isLineTerminator()) {
      this.expectPlugin("decoratorAutoAccessors"), this.resetPreviousNodeTrailingComments(key);
      const isPrivate2 = this.match(tt.privateName);
      this.parseClassElementName(publicProp), this.pushClassAccessorProperty(classBody, accessorProp, isPrivate2);
    } else this.isLineTerminator() ? isPrivate ? this.pushClassPrivateProperty(classBody, privateProp) : this.pushClassProperty(classBody, publicProp) : this.unexpected();
  }
  parseClassElementName(member) {
    const {
      type,
      value
    } = this.state;
    if ((type === tt.name || type === tt.string) && member.static && value === "prototype" && this.raise(Errors.StaticPrototype, this.state.startLoc), type === tt.privateName) {
      value === "constructor" && this.raise(Errors.ConstructorClassPrivateField, this.state.startLoc);
      const key = this.parsePrivateName();
      return member.key = key, key;
    }
    return this.parsePropertyName(member), member.key;
  }
  parseClassStaticBlock(classBody, member) {
    this.scope.enter(ScopeFlag.CLASS | ScopeFlag.STATIC_BLOCK | ScopeFlag.SUPER);
    const oldLabels = this.state.labels;
    this.state.labels = [], this.prodParam.enter(ParamKind.PARAM);
    const body = member.body = [];
    this.parseBlockOrModuleBlockBody(body, void 0, !1, tt.braceR), this.prodParam.exit(), this.scope.exit(), this.state.labels = oldLabels, classBody.body.push(this.finishNode(member, "StaticBlock")), member.decorators?.length && this.raise(Errors.DecoratorStaticBlock, member);
  }
  pushClassProperty(classBody, prop) {
    !prop.computed && this.nameIsConstructor(prop.key) && this.raise(Errors.ConstructorClassField, prop.key), classBody.body.push(this.parseClassProperty(prop));
  }
  pushClassPrivateProperty(classBody, prop) {
    const node = this.parseClassPrivateProperty(prop);
    classBody.body.push(node), this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), ClassElementType.OTHER, node.key.loc.start);
  }
  pushClassAccessorProperty(classBody, prop, isPrivate) {
    !isPrivate && !prop.computed && this.nameIsConstructor(prop.key) && this.raise(Errors.ConstructorClassField, prop.key);
    const node = this.parseClassAccessorProperty(prop);
    classBody.body.push(node), isPrivate && this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), ClassElementType.OTHER, node.key.loc.start);
  }
  pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
    classBody.body.push(this.parseMethod(method, isGenerator, isAsync, isConstructor, allowsDirectSuper, "ClassMethod", !0));
  }
  pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
    const node = this.parseMethod(method, isGenerator, isAsync, !1, !1, "ClassPrivateMethod", !0);
    classBody.body.push(node);
    const kind = node.kind === "get" ? node.static ? ClassElementType.STATIC_GETTER : ClassElementType.INSTANCE_GETTER : node.kind === "set" ? node.static ? ClassElementType.STATIC_SETTER : ClassElementType.INSTANCE_SETTER : ClassElementType.OTHER;
    this.declareClassPrivateMethodInScope(node, kind);
  }
  declareClassPrivateMethodInScope(node, kind) {
    this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), kind, node.key.loc.start);
  }
  parsePostMemberNameModifiers(methodOrProp) {
  }
  parseClassPrivateProperty(node) {
    return this.parseInitializer(node), this.semicolon(), this.finishNode(node, "ClassPrivateProperty");
  }
  parseClassProperty(node) {
    return this.parseInitializer(node), this.semicolon(), this.finishNode(node, "ClassProperty");
  }
  parseClassAccessorProperty(node) {
    return this.parseInitializer(node), this.semicolon(), this.finishNode(node, "ClassAccessorProperty");
  }
  parseInitializer(node) {
    this.scope.enter(ScopeFlag.CLASS | ScopeFlag.SUPER), this.expressionScope.enter(newExpressionScope()), this.prodParam.enter(ParamKind.PARAM), node.value = this.eat(tt.eq) ? this.parseMaybeAssignAllowIn() : null, this.expressionScope.exit(), this.prodParam.exit(), this.scope.exit();
  }
  parseClassId(node, isStatement, optionalId, bindingType = BindingFlag.TYPE_CLASS) {
    if (tokenIsIdentifier(this.state.type))
      node.id = this.parseIdentifier(), isStatement && this.declareNameFromIdentifier(node.id, bindingType);
    else if (optionalId || !isStatement)
      node.id = null;
    else
      throw this.raise(Errors.MissingClassName, this.state.startLoc);
  }
  parseClassSuper(node) {
    node.superClass = this.eat(tt._extends) ? this.parseExprSubscripts() : null;
  }
  parseExport(node, decorators) {
    const maybeDefaultIdentifier = this.parseMaybeImportPhase(node, !0), hasDefault = this.maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier), parseAfterDefault = !hasDefault || this.eat(tt.comma), hasStar = parseAfterDefault && this.eatExportStar(node), hasNamespace = hasStar && this.maybeParseExportNamespaceSpecifier(node), parseAfterNamespace = parseAfterDefault && (!hasNamespace || this.eat(tt.comma)), isFromRequired = hasDefault || hasStar;
    if (hasStar && !hasNamespace) {
      if (hasDefault && this.unexpected(), decorators)
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      return this.parseExportFrom(node, !0), this.sawUnambiguousESM = !0, this.finishNode(node, "ExportAllDeclaration");
    }
    const hasSpecifiers = this.maybeParseExportNamedSpecifiers(node);
    hasDefault && parseAfterDefault && !hasStar && !hasSpecifiers && this.unexpected(null, tt.braceL), hasNamespace && parseAfterNamespace && this.unexpected(null, tt._from);
    let hasDeclaration;
    if (isFromRequired || hasSpecifiers) {
      if (hasDeclaration = !1, decorators)
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      this.parseExportFrom(node, isFromRequired);
    } else
      hasDeclaration = this.maybeParseExportDeclaration(node);
    if (isFromRequired || hasSpecifiers || hasDeclaration) {
      const node2 = node;
      if (this.checkExport(node2, !0, !1, !!node2.source), node2.declaration?.type === "ClassDeclaration")
        this.maybeTakeDecorators(decorators, node2.declaration, node2);
      else if (decorators)
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      return this.sawUnambiguousESM = !0, this.finishNode(node2, "ExportNamedDeclaration");
    }
    if (this.eat(tt._default)) {
      const node2 = node, decl = this.parseExportDefaultExpression();
      if (node2.declaration = decl, decl.type === "ClassDeclaration")
        this.maybeTakeDecorators(decorators, decl, node2);
      else if (decorators)
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      return this.checkExport(node2, !0, !0), this.sawUnambiguousESM = !0, this.finishNode(node2, "ExportDefaultDeclaration");
    }
    throw this.unexpected(null, tt.braceL);
  }
  eatExportStar(node) {
    return this.eat(tt.star);
  }
  maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier) {
    if (maybeDefaultIdentifier || this.isExportDefaultSpecifier()) {
      this.expectPlugin("exportDefaultFrom", maybeDefaultIdentifier?.loc.start);
      const id = maybeDefaultIdentifier || this.parseIdentifier(!0), specifier = this.startNodeAtNode(id);
      return specifier.exported = id, node.specifiers = [this.finishNode(specifier, "ExportDefaultSpecifier")], !0;
    }
    return !1;
  }
  maybeParseExportNamespaceSpecifier(node) {
    if (this.isContextual(tt._as)) {
      node.specifiers ??= [];
      const specifier = this.startNodeAt(this.state.lastTokStartLoc);
      return this.next(), specifier.exported = this.parseModuleExportName(), node.specifiers.push(this.finishNode(specifier, "ExportNamespaceSpecifier")), !0;
    }
    return !1;
  }
  maybeParseExportNamedSpecifiers(node) {
    if (this.match(tt.braceL)) {
      const node2 = node;
      node2.specifiers || (node2.specifiers = []);
      const isTypeExport = node2.exportKind === "type";
      return node2.specifiers.push(...this.parseExportSpecifiers(isTypeExport)), node2.source = null, this.hasPlugin("importAssertions") ? node2.assertions = [] : node2.attributes = [], node2.declaration = null, !0;
    }
    return !1;
  }
  maybeParseExportDeclaration(node) {
    return this.shouldParseExportDeclaration() ? (node.specifiers = [], node.source = null, this.hasPlugin("importAssertions") ? node.assertions = [] : node.attributes = [], node.declaration = this.parseExportDeclaration(node), !0) : !1;
  }
  isAsyncFunction() {
    if (!this.isContextual(tt._async)) return !1;
    const next = this.nextTokenInLineStart();
    return this.isUnparsedContextual(next, "function");
  }
  parseExportDefaultExpression() {
    const expr = this.startNode();
    if (this.match(tt._function))
      return this.next(), this.parseFunction(expr, ParseFunctionFlag.Declaration | ParseFunctionFlag.NullableId);
    if (this.isAsyncFunction())
      return this.next(), this.next(), this.parseFunction(expr, ParseFunctionFlag.Declaration | ParseFunctionFlag.NullableId | ParseFunctionFlag.Async);
    if (this.match(tt._class))
      return this.parseClass(expr, !0, !0);
    if (this.match(tt.at))
      return this.hasPlugin("decorators") && this.getPluginOption("decorators", "decoratorsBeforeExport") === !0 && this.raise(Errors.DecoratorBeforeExport, this.state.startLoc), this.parseClass(this.maybeTakeDecorators(this.parseDecorators(!1), this.startNode()), !0, !0);
    if (this.match(tt._const) || this.match(tt._var) || this.isLet() || this.isUsing() || this.isAwaitUsing())
      throw this.raise(Errors.UnsupportedDefaultExport, this.state.startLoc);
    const res = this.parseMaybeAssignAllowIn();
    return this.semicolon(), res;
  }
  parseExportDeclaration(node) {
    return this.match(tt._class) ? this.parseClass(this.startNode(), !0, !1) : this.parseStatementListItem();
  }
  isExportDefaultSpecifier() {
    const {
      type
    } = this.state;
    if (tokenIsIdentifier(type)) {
      if (type === tt._async && !this.state.containsEsc || type === tt._let)
        return !1;
      if ((type === tt._type || type === tt._interface) && !this.state.containsEsc) {
        const next2 = this.nextTokenStart(), nextChar = this.input.charCodeAt(next2);
        if (nextChar === 123 || this.chStartsBindingIdentifier(nextChar, next2) && !this.input.startsWith("from", next2))
          return this.expectOnePlugin(["flow", "typescript"]), !1;
      }
    } else if (!this.match(tt._default))
      return !1;
    const next = this.nextTokenStart(), hasFrom = this.isUnparsedContextual(next, "from");
    if (this.input.charCodeAt(next) === 44 || tokenIsIdentifier(this.state.type) && hasFrom)
      return !0;
    if (this.match(tt._default) && hasFrom) {
      const nextAfterFrom = this.input.charCodeAt(this.nextTokenStartSince(next + 4));
      return nextAfterFrom === 34 || nextAfterFrom === 39;
    }
    return !1;
  }
  parseExportFrom(node, expect) {
    this.eatContextual(tt._from) ? (node.source = this.parseImportSource(), this.checkExport(node), this.maybeParseImportAttributes(node), this.checkJSONModuleImport(node)) : expect && this.unexpected(), this.semicolon();
  }
  shouldParseExportDeclaration() {
    const {
      type
    } = this.state;
    return type === tt.at && (this.expectOnePlugin(["decorators", "decorators-legacy"]), this.hasPlugin("decorators")) ? (this.getPluginOption("decorators", "decoratorsBeforeExport") === !0 && this.raise(Errors.DecoratorBeforeExport, this.state.startLoc), !0) : this.isUsing() ? (this.raise(Errors.UsingDeclarationExport, this.state.startLoc), !0) : this.isAwaitUsing() ? (this.raise(Errors.UsingDeclarationExport, this.state.startLoc), !0) : type === tt._var || type === tt._const || type === tt._function || type === tt._class || this.isLet() || this.isAsyncFunction();
  }
  checkExport(node, checkNames, isDefault, isFrom) {
    if (checkNames) {
      if (isDefault) {
        if (this.checkDuplicateExports(node, "default"), this.hasPlugin("exportDefaultFrom")) {
          const declaration = node.declaration;
          declaration.type === "Identifier" && declaration.name === "from" && declaration.end - declaration.start === 4 && !declaration.extra?.parenthesized && this.raise(Errors.ExportDefaultFromAsIdentifier, declaration);
        }
      } else if (node.specifiers?.length)
        for (const specifier of node.specifiers) {
          const {
            exported
          } = specifier, exportName = exported.type === "Identifier" ? exported.name : exported.value;
          if (this.checkDuplicateExports(specifier, exportName), !isFrom && specifier.local) {
            const {
              local
            } = specifier;
            local.type !== "Identifier" ? this.raise(Errors.ExportBindingIsString, specifier, {
              localName: local.value,
              exportName
            }) : (this.checkReservedWord(local.name, local.loc.start, !0, !1), this.scope.checkLocalExport(local));
          }
        }
      else if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          const {
            id
          } = decl;
          if (!id) throw new Error("Assertion failure");
          this.checkDuplicateExports(node, id.name);
        } else if (decl.type === "VariableDeclaration")
          for (const declaration of decl.declarations)
            this.checkDeclaration(declaration.id);
      }
    }
  }
  checkDeclaration(node) {
    if (node.type === "Identifier")
      this.checkDuplicateExports(node, node.name);
    else if (node.type === "ObjectPattern")
      for (const prop of node.properties)
        this.checkDeclaration(prop);
    else if (node.type === "ArrayPattern")
      for (const elem of node.elements)
        elem && this.checkDeclaration(elem);
    else node.type === "ObjectProperty" ? this.checkDeclaration(node.value) : node.type === "RestElement" ? this.checkDeclaration(node.argument) : node.type === "AssignmentPattern" && this.checkDeclaration(node.left);
  }
  checkDuplicateExports(node, exportName) {
    this.exportedIdentifiers.has(exportName) && (exportName === "default" ? this.raise(Errors.DuplicateDefaultExport, node) : this.raise(Errors.DuplicateExport, node, {
      exportName
    })), this.exportedIdentifiers.add(exportName);
  }
  parseExportSpecifiers(isInTypeExport) {
    const nodes = [];
    let first = !0;
    for (this.expect(tt.braceL); !this.eat(tt.braceR); ) {
      if (first)
        first = !1;
      else if (this.expect(tt.comma), this.eat(tt.braceR)) break;
      const isMaybeTypeOnly = this.isContextual(tt._type), isString = this.match(tt.string), node = this.startNode();
      node.local = this.parseModuleExportName(), nodes.push(this.parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly));
    }
    return nodes;
  }
  parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly) {
    return this.eatContextual(tt._as) ? node.exported = this.parseModuleExportName() : isString ? node.exported = this.cloneStringLiteral(node.local) : node.exported || (node.exported = this.cloneIdentifier(node.local)), this.finishNode(node, "ExportSpecifier");
  }
  parseModuleExportName() {
    if (this.match(tt.string)) {
      const result = this.parseStringLiteral(this.state.value), surrogate = loneSurrogate.exec(result.value);
      return surrogate && this.raise(Errors.ModuleExportNameHasLoneSurrogate, result, {
        surrogateCharCode: surrogate[0].charCodeAt(0)
      }), result;
    }
    return this.parseIdentifier(!0);
  }
  isJSONModuleImport(node) {
    return node.assertions != null ? node.assertions.some(({
      key,
      value
    }) => value.value === "json" && (key.type === "Identifier" ? key.name === "type" : key.value === "type")) : !1;
  }
  checkImportReflection(node) {
    const {
      specifiers
    } = node, singleBindingType = specifiers.length === 1 ? specifiers[0].type : null;
    node.phase === "source" ? singleBindingType !== "ImportDefaultSpecifier" && this.raise(Errors.SourcePhaseImportRequiresDefault, specifiers[0].loc.start) : node.phase === "defer" ? singleBindingType !== "ImportNamespaceSpecifier" && this.raise(Errors.DeferImportRequiresNamespace, specifiers[0].loc.start) : node.module && (singleBindingType !== "ImportDefaultSpecifier" && this.raise(Errors.ImportReflectionNotBinding, specifiers[0].loc.start), node.assertions?.length > 0 && this.raise(Errors.ImportReflectionHasAssertion, specifiers[0].loc.start));
  }
  checkJSONModuleImport(node) {
    if (this.isJSONModuleImport(node) && node.type !== "ExportAllDeclaration") {
      const {
        specifiers
      } = node;
      if (specifiers != null) {
        const nonDefaultNamedSpecifier = specifiers.find((specifier) => {
          let imported;
          if (specifier.type === "ExportSpecifier" ? imported = specifier.local : specifier.type === "ImportSpecifier" && (imported = specifier.imported), imported !== void 0)
            return imported.type === "Identifier" ? imported.name !== "default" : imported.value !== "default";
        });
        nonDefaultNamedSpecifier !== void 0 && this.raise(Errors.ImportJSONBindingNotDefault, nonDefaultNamedSpecifier.loc.start);
      }
    }
  }
  isPotentialImportPhase(isExport) {
    return isExport ? !1 : this.isContextual(tt._source) || this.isContextual(tt._defer) || this.isContextual(tt._module);
  }
  applyImportPhase(node, isExport, phase, loc) {
    isExport || (phase === "module" ? (this.expectPlugin("importReflection", loc), node.module = !0) : this.hasPlugin("importReflection") && (node.module = !1), phase === "source" ? (this.expectPlugin("sourcePhaseImports", loc), node.phase = "source") : phase === "defer" ? (this.expectPlugin("deferredImportEvaluation", loc), node.phase = "defer") : this.hasPlugin("sourcePhaseImports") && (node.phase = null));
  }
  parseMaybeImportPhase(node, isExport) {
    if (!this.isPotentialImportPhase(isExport))
      return this.applyImportPhase(node, isExport, null), null;
    const phaseIdentifier = this.startNode(), phaseIdentifierName = this.parseIdentifierName(!0), {
      type
    } = this.state;
    return (tokenIsKeywordOrIdentifier(type) ? type !== tt._from || this.lookaheadCharCode() === 102 : type !== tt.comma) ? (this.applyImportPhase(node, isExport, phaseIdentifierName, phaseIdentifier.loc.start), null) : (this.applyImportPhase(node, isExport, null), this.createIdentifier(phaseIdentifier, phaseIdentifierName));
  }
  isPrecedingIdImportPhase(phase) {
    const {
      type
    } = this.state;
    return tokenIsIdentifier(type) ? type !== tt._from || this.lookaheadCharCode() === 102 : type !== tt.comma;
  }
  parseImport(node) {
    return this.match(tt.string) ? this.parseImportSourceAndAttributes(node) : this.parseImportSpecifiersAndAfter(node, this.parseMaybeImportPhase(node, !1));
  }
  parseImportSpecifiersAndAfter(node, maybeDefaultIdentifier) {
    node.specifiers = [];
    const parseNext = !this.maybeParseDefaultImportSpecifier(node, maybeDefaultIdentifier) || this.eat(tt.comma), hasStar = parseNext && this.maybeParseStarImportSpecifier(node);
    return parseNext && !hasStar && this.parseNamedImportSpecifiers(node), this.expectContextual(tt._from), this.parseImportSourceAndAttributes(node);
  }
  parseImportSourceAndAttributes(node) {
    return node.specifiers ??= [], node.source = this.parseImportSource(), this.maybeParseImportAttributes(node), this.checkImportReflection(node), this.checkJSONModuleImport(node), this.semicolon(), this.sawUnambiguousESM = !0, this.finishNode(node, "ImportDeclaration");
  }
  parseImportSource() {
    return this.match(tt.string) || this.unexpected(), this.parseExprAtom();
  }
  parseImportSpecifierLocal(node, specifier, type) {
    specifier.local = this.parseIdentifier(), node.specifiers.push(this.finishImportSpecifier(specifier, type));
  }
  finishImportSpecifier(specifier, type, bindingType = BindingFlag.TYPE_LEXICAL) {
    return this.checkLVal(specifier.local, {
      type
    }, bindingType), this.finishNode(specifier, type);
  }
  parseImportAttributes() {
    this.expect(tt.braceL);
    const attrs = [], attrNames = /* @__PURE__ */ new Set();
    do {
      if (this.match(tt.braceR))
        break;
      const node = this.startNode(), keyName = this.state.value;
      if (attrNames.has(keyName) && this.raise(Errors.ModuleAttributesWithDuplicateKeys, this.state.startLoc, {
        key: keyName
      }), attrNames.add(keyName), this.match(tt.string) ? node.key = this.parseStringLiteral(keyName) : node.key = this.parseIdentifier(!0), this.expect(tt.colon), !this.match(tt.string))
        throw this.raise(Errors.ModuleAttributeInvalidValue, this.state.startLoc);
      node.value = this.parseStringLiteral(this.state.value), attrs.push(this.finishNode(node, "ImportAttribute"));
    } while (this.eat(tt.comma));
    return this.expect(tt.braceR), attrs;
  }
  parseModuleAttributes() {
    const attrs = [], attributes = /* @__PURE__ */ new Set();
    do {
      const node = this.startNode();
      if (node.key = this.parseIdentifier(!0), node.key.name !== "type" && this.raise(Errors.ModuleAttributeDifferentFromType, node.key), attributes.has(node.key.name) && this.raise(Errors.ModuleAttributesWithDuplicateKeys, node.key, {
        key: node.key.name
      }), attributes.add(node.key.name), this.expect(tt.colon), !this.match(tt.string))
        throw this.raise(Errors.ModuleAttributeInvalidValue, this.state.startLoc);
      node.value = this.parseStringLiteral(this.state.value), attrs.push(this.finishNode(node, "ImportAttribute"));
    } while (this.eat(tt.comma));
    return attrs;
  }
  maybeParseImportAttributes(node) {
    let attributes;
    var useWith = !1;
    if (this.match(tt._with)) {
      if (this.hasPrecedingLineBreak() && this.lookaheadCharCode() === 40)
        return;
      this.next(), this.hasPlugin("moduleAttributes") ? (attributes = this.parseModuleAttributes(), this.addExtra(node, "deprecatedWithLegacySyntax", !0)) : attributes = this.parseImportAttributes(), useWith = !0;
    } else this.isContextual(tt._assert) && !this.hasPrecedingLineBreak() ? (!this.hasPlugin("deprecatedImportAssert") && !this.hasPlugin("importAssertions") && this.raise(Errors.ImportAttributesUseAssert, this.state.startLoc), this.hasPlugin("importAssertions") || this.addExtra(node, "deprecatedAssertSyntax", !0), this.next(), attributes = this.parseImportAttributes()) : attributes = [];
    !useWith && this.hasPlugin("importAssertions") ? node.assertions = attributes : node.attributes = attributes;
  }
  maybeParseDefaultImportSpecifier(node, maybeDefaultIdentifier) {
    if (maybeDefaultIdentifier) {
      const specifier = this.startNodeAtNode(maybeDefaultIdentifier);
      return specifier.local = maybeDefaultIdentifier, node.specifiers.push(this.finishImportSpecifier(specifier, "ImportDefaultSpecifier")), !0;
    } else if (tokenIsKeywordOrIdentifier(this.state.type))
      return this.parseImportSpecifierLocal(node, this.startNode(), "ImportDefaultSpecifier"), !0;
    return !1;
  }
  maybeParseStarImportSpecifier(node) {
    if (this.match(tt.star)) {
      const specifier = this.startNode();
      return this.next(), this.expectContextual(tt._as), this.parseImportSpecifierLocal(node, specifier, "ImportNamespaceSpecifier"), !0;
    }
    return !1;
  }
  parseNamedImportSpecifiers(node) {
    let first = !0;
    for (this.expect(tt.braceL); !this.eat(tt.braceR); ) {
      if (first)
        first = !1;
      else {
        if (this.eat(tt.colon))
          throw this.raise(Errors.DestructureNamedImport, this.state.startLoc);
        if (this.expect(tt.comma), this.eat(tt.braceR)) break;
      }
      const specifier = this.startNode(), importedIsString = this.match(tt.string), isMaybeTypeOnly = this.isContextual(tt._type);
      specifier.imported = this.parseModuleExportName();
      const importSpecifier = this.parseImportSpecifier(specifier, importedIsString, node.importKind === "type" || node.importKind === "typeof", isMaybeTypeOnly, void 0);
      node.specifiers.push(importSpecifier);
    }
  }
  parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
    if (this.eatContextual(tt._as))
      specifier.local = this.parseIdentifier();
    else {
      const {
        imported
      } = specifier;
      if (importedIsString)
        throw this.raise(Errors.ImportBindingIsString, specifier, {
          importName: imported.value
        });
      this.checkReservedWord(imported.name, specifier.loc.start, !0, !0), specifier.local || (specifier.local = this.cloneIdentifier(imported));
    }
    return this.finishImportSpecifier(specifier, "ImportSpecifier", bindingType);
  }
  isThisParam(param) {
    return param.type === "Identifier" && param.name === "this";
  }
}
export {
  ParseFunctionFlag,
  ParseStatementFlag,
  StatementParser as default
};
