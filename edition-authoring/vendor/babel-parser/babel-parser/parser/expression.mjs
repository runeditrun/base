// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenCanStartExpression, tokenIsAssignment, tokenIsIdentifier, tokenIsKeywordOrIdentifier, tokenIsOperator, tokenIsPostfix, tokenIsPrefix, tokenIsRightAssociative, tokenIsTemplate, tokenKeywordOrIdentifierIsKeyword, tokenLabelName, tokenOperatorPrecedence, tt } from "../tokenizer/types.mjs";
import LValParser from "./lval.mjs";
import { isKeyword, isReservedWord, isStrictReservedWord, isStrictBindReservedWord, isIdentifierStart, canBeReservedWord } from "../util/identifier.mjs";
import { createPositionWithColumnOffset } from "../util/location.mjs";
import { ScopeFlag, BindingFlag } from "../util/scopeflags.mjs";
import { ExpressionErrors } from "./util.mjs";
import { ParamKind, functionFlags } from "../util/production-parameter.mjs";
import { newArrowHeadScope, newAsyncArrowScope, newExpressionScope } from "../util/expression-scope.mjs";
import { Errors } from "../parse-error.mjs";
import { UnparenthesizedPipeBodyDescriptions } from "../parse-error/pipeline-operator-errors.mjs";
import { setInnerComments } from "./comments.mjs";
import { OptionFlags } from "../options.mjs";
class ExpressionParser extends LValParser {
  checkProto(prop, isRecord, sawProto, refExpressionErrors) {
    if (prop.type === "SpreadElement" || this.isObjectMethod(prop) || prop.computed || prop.shorthand)
      return sawProto;
    const key = prop.key;
    return (key.type === "Identifier" ? key.name : key.value) === "__proto__" ? isRecord ? (this.raise(Errors.RecordNoProto, key), !0) : (sawProto && (refExpressionErrors ? refExpressionErrors.doubleProtoLoc === null && (refExpressionErrors.doubleProtoLoc = key.loc.start) : this.raise(Errors.DuplicateProto, key)), !0) : sawProto;
  }
  shouldExitDescending(expr, potentialArrowAt) {
    return expr.type === "ArrowFunctionExpression" && this.offsetToSourcePos(expr.start) === potentialArrowAt;
  }
  getExpression() {
    if (this.enterInitialScopes(), this.nextToken(), this.match(tt.eof))
      throw this.raise(Errors.ParseExpressionEmptyInput, this.state.startLoc);
    const expr = this.parseExpression();
    if (!this.match(tt.eof))
      throw this.raise(Errors.ParseExpressionExpectsEOF, this.state.startLoc, {
        unexpected: this.input.codePointAt(this.state.start)
      });
    return this.finalizeRemainingComments(), expr.comments = this.comments, expr.errors = this.state.errors, this.optionFlags & OptionFlags.Tokens && (expr.tokens = this.tokens), expr;
  }
  parseExpression(disallowIn, refExpressionErrors) {
    return disallowIn ? this.disallowInAnd(() => this.parseExpressionBase(refExpressionErrors)) : this.allowInAnd(() => this.parseExpressionBase(refExpressionErrors));
  }
  parseExpressionBase(refExpressionErrors) {
    const startLoc = this.state.startLoc, expr = this.parseMaybeAssign(refExpressionErrors);
    if (this.match(tt.comma)) {
      const node = this.startNodeAt(startLoc);
      for (node.expressions = [expr]; this.eat(tt.comma); )
        node.expressions.push(this.parseMaybeAssign(refExpressionErrors));
      return this.toReferencedList(node.expressions), this.finishNode(node, "SequenceExpression");
    }
    return expr;
  }
  parseMaybeAssignDisallowIn(refExpressionErrors, afterLeftParse) {
    return this.disallowInAnd(() => this.parseMaybeAssign(refExpressionErrors, afterLeftParse));
  }
  parseMaybeAssignAllowIn(refExpressionErrors, afterLeftParse) {
    return this.allowInAnd(() => this.parseMaybeAssign(refExpressionErrors, afterLeftParse));
  }
  setOptionalParametersError(refExpressionErrors) {
    refExpressionErrors.optionalParametersLoc = this.state.startLoc;
  }
  parseMaybeAssign(refExpressionErrors, afterLeftParse) {
    const startLoc = this.state.startLoc, isYield = this.isContextual(tt._yield);
    if (isYield && this.prodParam.hasYield) {
      this.next();
      let left2 = this.parseYield(startLoc);
      return afterLeftParse && (left2 = afterLeftParse.call(this, left2, startLoc)), left2;
    }
    let ownExpressionErrors;
    refExpressionErrors ? ownExpressionErrors = !1 : (refExpressionErrors = new ExpressionErrors(), ownExpressionErrors = !0);
    const {
      type
    } = this.state;
    (type === tt.parenL || tokenIsIdentifier(type)) && (this.state.potentialArrowAt = this.state.start);
    let left = this.parseMaybeConditional(refExpressionErrors);
    if (afterLeftParse && (left = afterLeftParse.call(this, left, startLoc)), tokenIsAssignment(this.state.type)) {
      const node = this.startNodeAt(startLoc), operator = this.state.value;
      if (node.operator = operator, this.match(tt.eq)) {
        this.toAssignable(left, !0), node.left = left;
        const startIndex = startLoc.index;
        refExpressionErrors.doubleProtoLoc != null && refExpressionErrors.doubleProtoLoc.index >= startIndex && (refExpressionErrors.doubleProtoLoc = null), refExpressionErrors.shorthandAssignLoc != null && refExpressionErrors.shorthandAssignLoc.index >= startIndex && (refExpressionErrors.shorthandAssignLoc = null), refExpressionErrors.privateKeyLoc != null && refExpressionErrors.privateKeyLoc.index >= startIndex && (this.checkDestructuringPrivate(refExpressionErrors), refExpressionErrors.privateKeyLoc = null), refExpressionErrors.voidPatternLoc != null && refExpressionErrors.voidPatternLoc.index >= startIndex && (refExpressionErrors.voidPatternLoc = null);
      } else
        node.left = left;
      return this.next(), node.right = this.parseMaybeAssign(), this.checkLVal(left, this.finishNode(node, "AssignmentExpression"), void 0, void 0, void 0, void 0, operator === "||=" || operator === "&&=" || operator === "??="), node;
    } else ownExpressionErrors && this.checkExpressionErrors(refExpressionErrors, !0);
    if (isYield) {
      const {
        type: type2
      } = this.state;
      if ((this.hasPlugin("v8intrinsic") ? tokenCanStartExpression(type2) : tokenCanStartExpression(type2) && !this.match(tt.modulo)) && !this.isAmbiguousPrefixOrIdentifier())
        return this.raiseOverwrite(Errors.YieldNotInGeneratorFunction, startLoc), this.parseYield(startLoc);
    }
    return left;
  }
  parseMaybeConditional(refExpressionErrors) {
    const startLoc = this.state.startLoc, potentialArrowAt = this.state.potentialArrowAt, expr = this.parseExprOps(refExpressionErrors);
    return this.shouldExitDescending(expr, potentialArrowAt) ? expr : this.parseConditional(expr, startLoc, refExpressionErrors);
  }
  parseConditional(expr, startLoc, refExpressionErrors) {
    if (this.eat(tt.question)) {
      const node = this.startNodeAt(startLoc);
      return node.test = expr, node.consequent = this.parseMaybeAssignAllowIn(), this.expect(tt.colon), node.alternate = this.parseMaybeAssign(), this.finishNode(node, "ConditionalExpression");
    }
    return expr;
  }
  parseMaybeUnaryOrPrivate(refExpressionErrors) {
    return this.match(tt.privateName) ? this.parsePrivateName() : this.parseMaybeUnary(refExpressionErrors);
  }
  parseExprOps(refExpressionErrors) {
    const startLoc = this.state.startLoc, potentialArrowAt = this.state.potentialArrowAt, expr = this.parseMaybeUnaryOrPrivate(refExpressionErrors);
    return this.shouldExitDescending(expr, potentialArrowAt) ? expr : this.parseExprOp(expr, startLoc, -1);
  }
  parseExprOp(left, leftStartLoc, minPrec) {
    if (this.isPrivateName(left)) {
      const value = this.getPrivateNameSV(left);
      (minPrec >= tokenOperatorPrecedence(tt._in) || !this.prodParam.hasIn || !this.match(tt._in)) && this.raise(Errors.PrivateInExpectedIn, left, {
        identifierName: value
      }), this.classScope.usePrivateName(value, left.loc.start);
    }
    const op = this.state.type;
    if (tokenIsOperator(op) && (this.prodParam.hasIn || !this.match(tt._in))) {
      let prec = tokenOperatorPrecedence(op);
      if (prec > minPrec) {
        if (op === tt.pipeline) {
          if (this.expectPlugin("pipelineOperator"), this.state.inFSharpPipelineDirectBody)
            return left;
          this.checkPipelineAtInfixOperator(left, leftStartLoc);
        }
        const node = this.startNodeAt(leftStartLoc);
        node.left = left, node.operator = this.state.value;
        const logical = op === tt.logicalOR || op === tt.logicalAND, coalesce = op === tt.nullishCoalescing;
        if (coalesce && (prec = tokenOperatorPrecedence(tt.logicalAND)), this.next(), op === tt.pipeline && this.hasPlugin(["pipelineOperator", {
          proposal: "minimal"
        }]) && this.state.type === tt._await && this.prodParam.hasAwait)
          throw this.raise(Errors.UnexpectedAwaitAfterPipelineBody, this.state.startLoc);
        node.right = this.parseExprOpRightExpr(op, prec);
        const finishedNode = this.finishNode(node, logical || coalesce ? "LogicalExpression" : "BinaryExpression"), nextOp = this.state.type;
        if (coalesce && (nextOp === tt.logicalOR || nextOp === tt.logicalAND) || logical && nextOp === tt.nullishCoalescing)
          throw this.raise(Errors.MixingCoalesceWithLogical, this.state.startLoc);
        return this.parseExprOp(finishedNode, leftStartLoc, minPrec);
      }
    }
    return left;
  }
  parseExprOpRightExpr(op, prec) {
    const startLoc = this.state.startLoc;
    switch (op) {
      case tt.pipeline:
        switch (this.getPluginOption("pipelineOperator", "proposal")) {
          case "hack":
            return this.withTopicBindingContext(() => this.parseHackPipeBody());
          case "fsharp":
            return this.withSoloAwaitPermittingContext(() => this.parseFSharpPipelineBody(prec));
        }
        if (this.getPluginOption("pipelineOperator", "proposal") === "smart")
          return this.withTopicBindingContext(() => {
            if (this.prodParam.hasYield && this.isContextual(tt._yield))
              throw this.raise(Errors.PipeBodyIsTighter, this.state.startLoc);
            return this.parseSmartPipelineBodyInStyle(this.parseExprOpBaseRightExpr(op, prec), startLoc);
          });
      default:
        return this.parseExprOpBaseRightExpr(op, prec);
    }
  }
  parseExprOpBaseRightExpr(op, prec) {
    const startLoc = this.state.startLoc;
    return this.parseExprOp(this.parseMaybeUnaryOrPrivate(), startLoc, tokenIsRightAssociative(op) ? prec - 1 : prec);
  }
  parseHackPipeBody() {
    const {
      startLoc
    } = this.state, body = this.parseMaybeAssign();
    return UnparenthesizedPipeBodyDescriptions.has(body.type) && !body.extra?.parenthesized && this.raise(Errors.PipeUnparenthesizedBody, startLoc, {
      type: body.type
    }), this.topicReferenceWasUsedInCurrentContext() || this.raise(Errors.PipeTopicUnused, startLoc), body;
  }
  checkExponentialAfterUnary(node) {
    this.match(tt.exponent) && this.raise(Errors.UnexpectedTokenUnaryExponentiation, node.argument);
  }
  parseMaybeUnary(refExpressionErrors, sawUnary) {
    const startLoc = this.state.startLoc, isAwait = this.isContextual(tt._await);
    if (isAwait && this.recordAwaitIfAllowed()) {
      this.next();
      const expr2 = this.parseAwait(startLoc);
      return sawUnary || this.checkExponentialAfterUnary(expr2), expr2;
    }
    const update = this.match(tt.incDec), node = this.startNode();
    if (tokenIsPrefix(this.state.type)) {
      node.operator = this.state.value, node.prefix = !0, this.match(tt._throw) && this.expectPlugin("throwExpressions");
      const isDelete = this.match(tt._delete);
      if (this.next(), node.argument = this.parseMaybeUnary(null, !0), this.checkExpressionErrors(refExpressionErrors, !0), this.state.strict && isDelete) {
        const arg = node.argument;
        arg.type === "Identifier" ? this.raise(Errors.StrictDelete, node) : this.hasPropertyAsPrivateName(arg) && this.raise(Errors.DeletePrivateField, node);
      }
      if (!update)
        return sawUnary || this.checkExponentialAfterUnary(node), this.finishNode(node, "UnaryExpression");
    }
    const expr = this.parseUpdate(node, update, refExpressionErrors);
    if (isAwait) {
      const {
        type
      } = this.state;
      if ((this.hasPlugin("v8intrinsic") ? tokenCanStartExpression(type) : tokenCanStartExpression(type) && !this.match(tt.modulo)) && !this.isAmbiguousPrefixOrIdentifier())
        return this.raiseOverwrite(Errors.AwaitNotInAsyncContext, startLoc), this.parseAwait(startLoc);
    }
    return expr;
  }
  parseUpdate(node, update, refExpressionErrors) {
    if (update) {
      const updateExpressionNode = node;
      return this.checkLVal(updateExpressionNode.argument, this.finishNode(updateExpressionNode, "UpdateExpression")), node;
    }
    const startLoc = this.state.startLoc;
    let expr = this.parseExprSubscripts(refExpressionErrors);
    if (this.checkExpressionErrors(refExpressionErrors, !1)) return expr;
    for (; tokenIsPostfix(this.state.type) && !this.canInsertSemicolon(); ) {
      const node2 = this.startNodeAt(startLoc);
      node2.operator = this.state.value, node2.prefix = !1, node2.argument = expr, this.next(), this.checkLVal(expr, expr = this.finishNode(node2, "UpdateExpression"));
    }
    return expr;
  }
  parseExprSubscripts(refExpressionErrors) {
    const startLoc = this.state.startLoc, potentialArrowAt = this.state.potentialArrowAt, expr = this.parseExprAtom(refExpressionErrors);
    return this.shouldExitDescending(expr, potentialArrowAt) ? expr : this.parseSubscripts(expr, startLoc);
  }
  parseSubscripts(base, startLoc, noCalls) {
    const state = {
      optionalChainMember: !1,
      maybeAsyncArrow: this.atPossibleAsyncArrow(base),
      stop: !1
    };
    do
      base = this.parseSubscript(base, startLoc, noCalls, state), state.maybeAsyncArrow = !1;
    while (!state.stop);
    return base;
  }
  parseSubscript(base, startLoc, noCalls, state) {
    const {
      type
    } = this.state;
    if (!noCalls && type === tt.doubleColon)
      return this.parseBind(base, startLoc, state);
    if (tokenIsTemplate(type))
      return this.parseTaggedTemplateExpression(base, startLoc, state);
    let optional = !1;
    if (type === tt.questionDot) {
      if (noCalls && (this.raise(Errors.OptionalChainingNoNew, this.state.startLoc), this.lookaheadCharCode() === 40))
        return this.stopParseSubscript(base, state);
      state.optionalChainMember = optional = !0, this.next();
    }
    if (!noCalls && this.match(tt.parenL))
      return this.parseCoverCallAndAsyncArrowHead(base, startLoc, state, optional);
    {
      const computed = this.eat(tt.bracketL);
      return computed || optional || this.eat(tt.dot) ? this.parseMember(base, startLoc, state, computed, optional) : this.stopParseSubscript(base, state);
    }
  }
  stopParseSubscript(base, state) {
    return state.stop = !0, base;
  }
  parseMember(base, startLoc, state, computed, optional) {
    const node = this.startNodeAt(startLoc);
    return node.object = base, node.computed = computed, computed ? (node.property = this.parseExpression(), this.expect(tt.bracketR)) : this.match(tt.privateName) ? (base.type === "Super" && this.raise(Errors.SuperPrivateField, startLoc), this.classScope.usePrivateName(this.state.value, this.state.startLoc), node.property = this.parsePrivateName()) : node.property = this.parseIdentifier(!0), state.optionalChainMember ? (node.optional = optional, this.finishNode(node, "OptionalMemberExpression")) : this.finishNode(node, "MemberExpression");
  }
  parseBind(base, startLoc, state) {
    const node = this.startNodeAt(startLoc);
    node.object = base, this.next();
    const isImport = this.match(tt._import), callee = this.parseNoCallExpr();
    if (callee.type === "Super" || isImport && callee.type === "ImportExpression" || callee.type === "Import")
      throw this.raise(Errors.UnsupportedBindRHS, callee);
    return node.callee = callee, state.stop = !0, this.parseSubscripts(this.finishNode(node, "BindExpression"), startLoc, !1);
  }
  parseCoverCallAndAsyncArrowHead(base, startLoc, state, optional) {
    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    let refExpressionErrors = null;
    this.state.maybeInArrowParameters = !0, this.next();
    const node = this.startNodeAt(startLoc);
    node.callee = base;
    const {
      maybeAsyncArrow,
      optionalChainMember
    } = state;
    maybeAsyncArrow && (this.expressionScope.enter(newAsyncArrowScope()), refExpressionErrors = new ExpressionErrors()), optionalChainMember && (node.optional = optional), optional ? node.arguments = this.parseCallExpressionArguments() : node.arguments = this.parseCallExpressionArguments(base.type !== "Super", node, refExpressionErrors);
    let finishedNode = this.finishCallExpression(node, optionalChainMember);
    return maybeAsyncArrow && this.shouldParseAsyncArrow() && !optional ? (state.stop = !0, this.checkDestructuringPrivate(refExpressionErrors), this.expressionScope.validateAsPattern(), this.expressionScope.exit(), finishedNode = this.parseAsyncArrowFromCallExpression(this.startNodeAt(startLoc), finishedNode)) : (maybeAsyncArrow && (this.checkExpressionErrors(refExpressionErrors, !0), this.expressionScope.exit()), this.toReferencedArguments(finishedNode)), this.state.maybeInArrowParameters = oldMaybeInArrowParameters, finishedNode;
  }
  toReferencedArguments(node, isParenthesizedExpr) {
    this.toReferencedListDeep(node.arguments, isParenthesizedExpr);
  }
  parseTaggedTemplateExpression(base, startLoc, state) {
    const node = this.startNodeAt(startLoc);
    return node.tag = base, node.quasi = this.parseTemplate(!0), state.optionalChainMember && this.raise(Errors.OptionalChainingNoTemplate, startLoc), this.finishNode(node, "TaggedTemplateExpression");
  }
  atPossibleAsyncArrow(base) {
    return base.type === "Identifier" && base.name === "async" && this.state.lastTokEndLoc.index === base.end && !this.canInsertSemicolon() && base.end - base.start === 5 && this.offsetToSourcePos(base.start) === this.state.potentialArrowAt;
  }
  finishCallExpression(node, optional) {
    if (node.callee.type === "Import")
      if (node.arguments.length === 0 || node.arguments.length > 2)
        this.raise(Errors.ImportCallArity, node);
      else
        for (const arg of node.arguments)
          arg.type === "SpreadElement" && this.raise(Errors.ImportCallSpreadArgument, arg);
    return this.finishNode(node, optional ? "OptionalCallExpression" : "CallExpression");
  }
  parseCallExpressionArguments(allowPlaceholder, nodeForExtra, refExpressionErrors) {
    const elts = [];
    let first = !0;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    for (this.state.inFSharpPipelineDirectBody = !1; !this.eat(tt.parenR); ) {
      if (first)
        first = !1;
      else if (this.expect(tt.comma), this.match(tt.parenR)) {
        nodeForExtra && this.addTrailingCommaExtraToNode(nodeForExtra), this.next();
        break;
      }
      elts.push(this.parseExprListItem(tt.parenR, !1, refExpressionErrors, allowPlaceholder));
    }
    return this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody, elts;
  }
  shouldParseAsyncArrow() {
    return this.match(tt.arrow) && !this.canInsertSemicolon();
  }
  parseAsyncArrowFromCallExpression(node, call) {
    return this.resetPreviousNodeTrailingComments(call), this.expect(tt.arrow), this.parseArrowExpression(node, call.arguments, !0, call.extra?.trailingCommaLoc), call.innerComments && setInnerComments(node, call.innerComments), call.callee.trailingComments && setInnerComments(node, call.callee.trailingComments), node;
  }
  parseNoCallExpr() {
    const startLoc = this.state.startLoc;
    return this.parseSubscripts(this.parseExprAtom(), startLoc, !0);
  }
  parseExprAtom(refExpressionErrors) {
    let node, decorators = null;
    const {
      type
    } = this.state;
    switch (type) {
      case tt._super:
        return this.parseSuper();
      case tt._import:
        return node = this.startNode(), this.next(), this.match(tt.dot) ? this.parseImportMetaPropertyOrPhaseCall(node) : this.match(tt.parenL) ? this.optionFlags & OptionFlags.CreateImportExpressions ? this.parseImportCall(node) : this.finishNode(node, "Import") : (this.raise(Errors.UnsupportedImport, this.state.lastTokStartLoc), this.finishNode(node, "Import"));
      case tt._this:
        return node = this.startNode(), this.next(), this.finishNode(node, "ThisExpression");
      case tt._do:
        return this.parseDo(this.startNode(), !1);
      case tt.slash:
      case tt.slashAssign:
        return this.readRegexp(), this.parseRegExpLiteral(this.state.value);
      case tt.num:
        return this.parseNumericLiteral(this.state.value);
      case tt.bigint:
        return this.parseBigIntLiteral(this.state.value);
      case tt.string:
        return this.parseStringLiteral(this.state.value);
      case tt._null:
        return this.parseNullLiteral();
      case tt._true:
        return this.parseBooleanLiteral(!0);
      case tt._false:
        return this.parseBooleanLiteral(!1);
      case tt.parenL: {
        const canBeArrow = this.state.potentialArrowAt === this.state.start;
        return this.parseParenAndDistinguishExpression(canBeArrow);
      }
      case tt.bracketL:
        return this.parseArrayLike(tt.bracketR, !1, refExpressionErrors);
      case tt.braceL:
        return this.parseObjectLike(tt.braceR, !1, !1, refExpressionErrors);
      case tt._function:
        return this.parseFunctionOrFunctionSent();
      case tt.at:
        decorators = this.parseDecorators();
      case tt._class:
        return this.parseClass(this.maybeTakeDecorators(decorators, this.startNode()), !1);
      case tt._new:
        return this.parseNewOrNewTarget();
      case tt.templateNonTail:
      case tt.templateTail:
        return this.parseTemplate(!1);
      case tt.doubleColon: {
        node = this.startNode(), this.next(), node.object = null;
        const callee = node.callee = this.parseNoCallExpr();
        if (callee.type === "MemberExpression")
          return this.finishNode(node, "BindExpression");
        throw this.raise(Errors.UnsupportedBind, callee);
      }
      case tt.privateName:
        return this.raise(Errors.PrivateInExpectedIn, this.state.startLoc, {
          identifierName: this.state.value
        }), this.parsePrivateName();
      case tt.moduloAssign:
        return this.parseTopicReferenceThenEqualsSign(tt.modulo, "%");
      case tt.xorAssign:
        return this.parseTopicReferenceThenEqualsSign(tt.bitwiseXOR, "^");
      case tt.doubleCaret:
      case tt.doubleAt:
        return this.parseTopicReference("hack");
      case tt.bitwiseXOR:
      case tt.modulo:
      case tt.hash: {
        const pipeProposal = this.getPluginOption("pipelineOperator", "proposal");
        if (pipeProposal)
          return this.parseTopicReference(pipeProposal);
        throw this.unexpected();
      }
      case tt.lt: {
        const lookaheadCh = this.input.codePointAt(this.nextTokenStart());
        throw isIdentifierStart(lookaheadCh) || lookaheadCh === 62 ? this.expectOnePlugin(["jsx", "flow", "typescript"]) : this.unexpected();
      }
      default:
        if (type === tt.decimal)
          return this.parseDecimalLiteral(this.state.value);
        if (type === tt.bracketBarL || type === tt.bracketHashL)
          return this.parseArrayLike(this.state.type === tt.bracketBarL ? tt.bracketBarR : tt.bracketR, !0);
        if (type === tt.braceBarL || type === tt.braceHashL)
          return this.parseObjectLike(this.state.type === tt.braceBarL ? tt.braceBarR : tt.braceR, !1, !0);
        if (tokenIsIdentifier(type)) {
          if (this.isContextual(tt._module) && this.lookaheadInLineCharCode() === 123)
            return this.parseModuleExpression();
          const canBeArrow = this.state.potentialArrowAt === this.state.start, containsEsc = this.state.containsEsc, id = this.parseIdentifier();
          if (!containsEsc && id.name === "async" && !this.canInsertSemicolon()) {
            const {
              type: type2
            } = this.state;
            if (type2 === tt._function)
              return this.resetPreviousNodeTrailingComments(id), this.next(), this.parseAsyncFunctionExpression(this.startNodeAtNode(id));
            if (tokenIsIdentifier(type2))
              return canBeArrow && this.lookaheadCharCode() === 61 ? this.parseAsyncArrowUnaryFunction(this.startNodeAtNode(id)) : id;
            if (type2 === tt._do)
              return this.resetPreviousNodeTrailingComments(id), this.parseDo(this.startNodeAtNode(id), !0);
          }
          return canBeArrow && this.match(tt.arrow) && !this.canInsertSemicolon() ? (this.next(), this.parseArrowExpression(this.startNodeAtNode(id), [id], !1)) : id;
        } else
          throw this.unexpected();
    }
  }
  parseTopicReferenceThenEqualsSign(topicTokenType, topicTokenValue) {
    const pipeProposal = this.getPluginOption("pipelineOperator", "proposal");
    if (pipeProposal)
      return this.state.type = topicTokenType, this.state.value = topicTokenValue, this.state.pos--, this.state.end--, this.state.endLoc = createPositionWithColumnOffset(this.state.endLoc, -1), this.parseTopicReference(pipeProposal);
    throw this.unexpected();
  }
  parseTopicReference(pipeProposal) {
    const node = this.startNode(), startLoc = this.state.startLoc, tokenType = this.state.type;
    return this.next(), this.finishTopicReference(node, startLoc, pipeProposal, tokenType);
  }
  finishTopicReference(node, startLoc, pipeProposal, tokenType) {
    if (this.testTopicReferenceConfiguration(pipeProposal, startLoc, tokenType))
      return pipeProposal === "hack" ? (this.topicReferenceIsAllowedInCurrentContext() || this.raise(Errors.PipeTopicUnbound, startLoc), this.registerTopicReference(), this.finishNode(node, "TopicReference")) : (this.topicReferenceIsAllowedInCurrentContext() || this.raise(Errors.PrimaryTopicNotAllowed, startLoc), this.registerTopicReference(), this.finishNode(node, "PipelinePrimaryTopicReference"));
    throw this.raise(Errors.PipeTopicUnconfiguredToken, startLoc, {
      token: tokenLabelName(tokenType)
    });
  }
  testTopicReferenceConfiguration(pipeProposal, startLoc, tokenType) {
    switch (pipeProposal) {
      case "hack":
        return this.hasPlugin(["pipelineOperator", {
          topicToken: tokenLabelName(tokenType)
        }]);
      case "smart":
        return tokenType === tt.hash;
      default:
        throw this.raise(Errors.PipeTopicRequiresHackPipes, startLoc);
    }
  }
  parseAsyncArrowUnaryFunction(node) {
    this.prodParam.enter(functionFlags(!0, this.prodParam.hasYield));
    const params = [this.parseIdentifier()];
    return this.prodParam.exit(), this.hasPrecedingLineBreak() && this.raise(Errors.LineTerminatorBeforeArrow, this.state.curPosition()), this.expect(tt.arrow), this.parseArrowExpression(node, params, !0);
  }
  parseDo(node, isAsync) {
    this.expectPlugin("doExpressions"), isAsync && this.expectPlugin("asyncDoExpressions"), node.async = isAsync, this.next();
    const oldLabels = this.state.labels;
    return this.state.labels = [], isAsync ? (this.prodParam.enter(ParamKind.PARAM_AWAIT), node.body = this.parseBlock(), this.prodParam.exit()) : node.body = this.parseBlock(), this.state.labels = oldLabels, this.finishNode(node, "DoExpression");
  }
  parseSuper() {
    const node = this.startNode();
    return this.next(), this.match(tt.parenL) && !this.scope.allowDirectSuper ? this.optionFlags & OptionFlags.AllowSuperOutsideMethod || this.raise(Errors.SuperNotAllowed, node) : this.scope.allowSuper || this.optionFlags & OptionFlags.AllowSuperOutsideMethod || this.raise(Errors.UnexpectedSuper, node), !this.match(tt.parenL) && !this.match(tt.bracketL) && !this.match(tt.dot) && this.raise(Errors.UnsupportedSuper, node), this.finishNode(node, "Super");
  }
  parsePrivateName() {
    const node = this.startNode(), id = this.startNodeAt(createPositionWithColumnOffset(this.state.startLoc, 1)), name = this.state.value;
    return this.next(), node.id = this.createIdentifier(id, name), this.finishNode(node, "PrivateName");
  }
  parseFunctionOrFunctionSent() {
    const node = this.startNode();
    if (this.next(), this.prodParam.hasYield && this.match(tt.dot)) {
      const meta = this.createIdentifier(this.startNodeAtNode(node), "function");
      return this.next(), this.match(tt._sent) ? this.expectPlugin("functionSent") : this.hasPlugin("functionSent") || this.unexpected(), this.parseMetaProperty(node, meta, "sent");
    }
    return this.parseFunction(node);
  }
  parseMetaProperty(node, meta, propertyName) {
    node.meta = meta;
    const containsEsc = this.state.containsEsc;
    return node.property = this.parseIdentifier(!0), (node.property.name !== propertyName || containsEsc) && this.raise(Errors.UnsupportedMetaProperty, node.property, {
      target: meta.name,
      onlyValidPropertyName: propertyName
    }), this.finishNode(node, "MetaProperty");
  }
  parseImportMetaPropertyOrPhaseCall(node) {
    if (this.next(), this.isContextual(tt._source) || this.isContextual(tt._defer)) {
      const isSource = this.isContextual(tt._source);
      return this.expectPlugin(isSource ? "sourcePhaseImports" : "deferredImportEvaluation"), this.next(), node.phase = isSource ? "source" : "defer", this.parseImportCall(node);
    } else {
      const id = this.createIdentifierAt(this.startNodeAtNode(node), "import", this.state.lastTokStartLoc);
      return this.isContextual(tt._meta) && (this.inModule || this.raise(Errors.ImportMetaOutsideModule, id), this.sawUnambiguousESM = !0), this.parseMetaProperty(node, id, "meta");
    }
  }
  parseLiteralAtNode(value, type, node) {
    return this.addExtra(node, "rawValue", value), this.addExtra(node, "raw", this.input.slice(this.offsetToSourcePos(node.start), this.state.end)), node.value = value, this.next(), this.finishNode(node, type);
  }
  parseLiteral(value, type) {
    const node = this.startNode();
    return this.parseLiteralAtNode(value, type, node);
  }
  parseStringLiteral(value) {
    return this.parseLiteral(value, "StringLiteral");
  }
  parseNumericLiteral(value) {
    return this.parseLiteral(value, "NumericLiteral");
  }
  parseBigIntLiteral(value) {
    return this.parseLiteral(value, "BigIntLiteral");
  }
  parseDecimalLiteral(value) {
    return this.parseLiteral(value, "DecimalLiteral");
  }
  parseRegExpLiteral(value) {
    const node = this.startNode();
    return this.addExtra(node, "raw", this.input.slice(this.offsetToSourcePos(node.start), this.state.end)), node.pattern = value.pattern, node.flags = value.flags, this.next(), this.finishNode(node, "RegExpLiteral");
  }
  parseBooleanLiteral(value) {
    const node = this.startNode();
    return node.value = value, this.next(), this.finishNode(node, "BooleanLiteral");
  }
  parseNullLiteral() {
    const node = this.startNode();
    return this.next(), this.finishNode(node, "NullLiteral");
  }
  parseParenAndDistinguishExpression(canBeArrow) {
    const startLoc = this.state.startLoc;
    let val;
    this.next(), this.expressionScope.enter(newArrowHeadScope());
    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters, oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.maybeInArrowParameters = !0, this.state.inFSharpPipelineDirectBody = !1;
    const innerStartLoc = this.state.startLoc, exprList = [], refExpressionErrors = new ExpressionErrors();
    let first = !0, spreadStartLoc, optionalCommaStartLoc;
    for (; !this.match(tt.parenR); ) {
      if (first)
        first = !1;
      else if (this.expect(tt.comma, refExpressionErrors.optionalParametersLoc === null ? null : refExpressionErrors.optionalParametersLoc), this.match(tt.parenR)) {
        optionalCommaStartLoc = this.state.startLoc;
        break;
      }
      if (this.match(tt.ellipsis)) {
        const spreadNodeStartLoc = this.state.startLoc;
        if (spreadStartLoc = this.state.startLoc, exprList.push(this.parseParenItem(this.parseRestBinding(), spreadNodeStartLoc)), !this.checkCommaAfterRest(41))
          break;
      } else
        exprList.push(this.parseMaybeAssignAllowInOrVoidPattern(tt.parenR, refExpressionErrors, this.parseParenItem));
    }
    const innerEndLoc = this.state.lastTokEndLoc;
    this.expect(tt.parenR), this.state.maybeInArrowParameters = oldMaybeInArrowParameters, this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
    let arrowNode = this.startNodeAt(startLoc);
    return canBeArrow && this.shouldParseArrow(exprList) && (arrowNode = this.parseArrow(arrowNode)) ? (this.checkDestructuringPrivate(refExpressionErrors), this.expressionScope.validateAsPattern(), this.expressionScope.exit(), this.parseArrowExpression(arrowNode, exprList, !1), arrowNode) : (this.expressionScope.exit(), exprList.length || this.unexpected(this.state.lastTokStartLoc), optionalCommaStartLoc && this.unexpected(optionalCommaStartLoc), spreadStartLoc && this.unexpected(spreadStartLoc), this.checkExpressionErrors(refExpressionErrors, !0), this.toReferencedListDeep(exprList, !0), exprList.length > 1 ? (val = this.startNodeAt(innerStartLoc), val.expressions = exprList, this.finishNode(val, "SequenceExpression"), this.resetEndLocation(val, innerEndLoc)) : val = exprList[0], this.wrapParenthesis(startLoc, val));
  }
  wrapParenthesis(startLoc, expression) {
    if (!(this.optionFlags & OptionFlags.CreateParenthesizedExpressions))
      return this.addExtra(expression, "parenthesized", !0), this.addExtra(expression, "parenStart", startLoc.index), this.takeSurroundingComments(expression, startLoc.index, this.state.lastTokEndLoc.index), expression;
    const parenExpression = this.startNodeAt(startLoc);
    return parenExpression.expression = expression, this.finishNode(parenExpression, "ParenthesizedExpression");
  }
  shouldParseArrow(params) {
    return !this.canInsertSemicolon();
  }
  parseArrow(node) {
    if (this.eat(tt.arrow))
      return node;
  }
  parseParenItem(node, startLoc) {
    return node;
  }
  parseNewOrNewTarget() {
    const node = this.startNode();
    if (this.next(), this.match(tt.dot)) {
      const meta = this.createIdentifier(this.startNodeAtNode(node), "new");
      this.next();
      const metaProp = this.parseMetaProperty(node, meta, "target");
      return this.scope.allowNewTarget || this.raise(Errors.UnexpectedNewTarget, metaProp), metaProp;
    }
    return this.parseNew(node);
  }
  parseNew(node) {
    if (this.parseNewCallee(node), this.eat(tt.parenL)) {
      const args = this.parseExprList(tt.parenR);
      this.toReferencedList(args), node.arguments = args;
    } else
      node.arguments = [];
    return this.finishNode(node, "NewExpression");
  }
  parseNewCallee(node) {
    const isImport = this.match(tt._import), callee = this.parseNoCallExpr();
    node.callee = callee, (isImport && callee.type === "ImportExpression" || callee.type === "Import") && this.raise(Errors.ImportCallNotNewExpression, callee), callee.type === "Super" && this.raise(Errors.SuperCallNotNewExpression, callee);
  }
  parseTemplateElement(isTagged) {
    const {
      start,
      startLoc,
      end,
      value
    } = this.state, elemStart = start + 1, elem = this.startNodeAt(createPositionWithColumnOffset(startLoc, 1));
    value === null && (isTagged || this.raise(Errors.InvalidEscapeSequenceTemplate, createPositionWithColumnOffset(this.state.firstInvalidTemplateEscapePos, 1)));
    const isTail = this.match(tt.templateTail), endOffset = isTail ? -1 : -2, elemEnd = end + endOffset;
    elem.value = {
      raw: this.input.slice(elemStart, elemEnd).replace(/\r\n?/g, `
`),
      cooked: value === null ? null : value.slice(1, endOffset)
    }, elem.tail = isTail, this.next();
    const finishedNode = this.finishNode(elem, "TemplateElement");
    return this.resetEndLocation(finishedNode, createPositionWithColumnOffset(this.state.lastTokEndLoc, endOffset)), finishedNode;
  }
  parseTemplate(isTagged) {
    const node = this.startNode();
    let curElt = this.parseTemplateElement(isTagged);
    const quasis = [curElt], substitutions = [];
    for (; !curElt.tail; )
      substitutions.push(this.parseTemplateSubstitution()), this.readTemplateContinuation(), quasis.push(curElt = this.parseTemplateElement(isTagged));
    return node.expressions = substitutions, node.quasis = quasis, this.finishNode(node, "TemplateLiteral");
  }
  parseTemplateSubstitution() {
    return this.parseExpression();
  }
  parseObjectLike(close, isPattern, isRecord, refExpressionErrors) {
    isRecord && this.expectPlugin("recordAndTuple");
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = !1;
    let sawProto = !1, first = !0;
    const node = this.startNode();
    for (node.properties = [], this.next(); !this.match(close); ) {
      if (first)
        first = !1;
      else if (this.expect(tt.comma), this.match(close)) {
        this.addTrailingCommaExtraToNode(node);
        break;
      }
      let prop;
      isPattern ? prop = this.parseBindingProperty() : (prop = this.parsePropertyDefinition(refExpressionErrors), sawProto = this.checkProto(prop, isRecord, sawProto, refExpressionErrors)), isRecord && !this.isObjectProperty(prop) && prop.type !== "SpreadElement" && this.raise(Errors.InvalidRecordProperty, prop), prop.shorthand && this.addExtra(prop, "shorthand", !0), node.properties.push(prop);
    }
    this.next(), this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
    let type = "ObjectExpression";
    return isPattern ? type = "ObjectPattern" : isRecord && (type = "RecordExpression"), this.finishNode(node, type);
  }
  addTrailingCommaExtraToNode(node) {
    this.addExtra(node, "trailingComma", this.state.lastTokStartLoc.index), this.addExtra(node, "trailingCommaLoc", this.state.lastTokStartLoc, !1);
  }
  maybeAsyncOrAccessorProp(prop) {
    return !prop.computed && prop.key.type === "Identifier" && (this.isLiteralPropertyName() || this.match(tt.bracketL) || this.match(tt.star));
  }
  parsePropertyDefinition(refExpressionErrors) {
    let decorators = [];
    if (this.match(tt.at))
      for (this.hasPlugin("decorators") && this.raise(Errors.UnsupportedPropertyDecorator, this.state.startLoc); this.match(tt.at); )
        decorators.push(this.parseDecorator());
    const prop = this.startNode();
    let isAsync = !1, isAccessor = !1, startLoc;
    if (this.match(tt.ellipsis))
      return decorators.length && this.unexpected(), this.parseSpread();
    decorators.length && (prop.decorators = decorators, decorators = []), prop.method = !1, refExpressionErrors && (startLoc = this.state.startLoc);
    let isGenerator = this.eat(tt.star);
    this.parsePropertyNamePrefixOperator(prop);
    const containsEsc = this.state.containsEsc;
    if (this.parsePropertyName(prop, refExpressionErrors), !isGenerator && !containsEsc && this.maybeAsyncOrAccessorProp(prop)) {
      const {
        key
      } = prop, keyName = key.name;
      keyName === "async" && !this.hasPrecedingLineBreak() && (isAsync = !0, this.resetPreviousNodeTrailingComments(key), isGenerator = this.eat(tt.star), this.parsePropertyName(prop)), (keyName === "get" || keyName === "set") && (isAccessor = !0, this.resetPreviousNodeTrailingComments(key), prop.kind = keyName, this.match(tt.star) && (isGenerator = !0, this.raise(Errors.AccessorIsGenerator, this.state.curPosition(), {
        kind: keyName
      }), this.next()), this.parsePropertyName(prop));
    }
    return this.parseObjPropValue(prop, startLoc, isGenerator, isAsync, !1, isAccessor, refExpressionErrors);
  }
  getGetterSetterExpectedParamCount(method) {
    return method.kind === "get" ? 0 : 1;
  }
  getObjectOrClassMethodParams(method) {
    return method.params;
  }
  checkGetterSetterParams(method) {
    const paramCount = this.getGetterSetterExpectedParamCount(method), params = this.getObjectOrClassMethodParams(method);
    params.length !== paramCount && this.raise(method.kind === "get" ? Errors.BadGetterArity : Errors.BadSetterArity, method), method.kind === "set" && params[params.length - 1]?.type === "RestElement" && this.raise(Errors.BadSetterRestParameter, method);
  }
  parseObjectMethod(prop, isGenerator, isAsync, isPattern, isAccessor) {
    if (isAccessor) {
      const finishedProp = this.parseMethod(prop, isGenerator, !1, !1, !1, "ObjectMethod");
      return this.checkGetterSetterParams(finishedProp), finishedProp;
    }
    if (isAsync || isGenerator || this.match(tt.parenL))
      return isPattern && this.unexpected(), prop.kind = "method", prop.method = !0, this.parseMethod(prop, isGenerator, isAsync, !1, !1, "ObjectMethod");
  }
  parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors) {
    if (prop.shorthand = !1, this.eat(tt.colon))
      return prop.value = isPattern ? this.parseMaybeDefault(this.state.startLoc) : this.parseMaybeAssignAllowInOrVoidPattern(tt.braceR, refExpressionErrors), this.finishObjectProperty(prop);
    if (!prop.computed && prop.key.type === "Identifier") {
      if (this.checkReservedWord(prop.key.name, prop.key.loc.start, !0, !1), isPattern)
        prop.value = this.parseMaybeDefault(startLoc, this.cloneIdentifier(prop.key));
      else if (this.match(tt.eq)) {
        const shorthandAssignLoc = this.state.startLoc;
        refExpressionErrors != null ? refExpressionErrors.shorthandAssignLoc === null && (refExpressionErrors.shorthandAssignLoc = shorthandAssignLoc) : this.raise(Errors.InvalidCoverInitializedName, shorthandAssignLoc), prop.value = this.parseMaybeDefault(startLoc, this.cloneIdentifier(prop.key));
      } else
        prop.value = this.cloneIdentifier(prop.key);
      return prop.shorthand = !0, this.finishObjectProperty(prop);
    }
  }
  finishObjectProperty(node) {
    return this.finishNode(node, "ObjectProperty");
  }
  parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
    const node = this.parseObjectMethod(prop, isGenerator, isAsync, isPattern, isAccessor) || this.parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors);
    return node || this.unexpected(), node;
  }
  parsePropertyName(prop, refExpressionErrors) {
    if (this.eat(tt.bracketL))
      prop.computed = !0, prop.key = this.parseMaybeAssignAllowIn(), this.expect(tt.bracketR);
    else {
      const {
        type,
        value
      } = this.state;
      let key;
      if (tokenIsKeywordOrIdentifier(type))
        key = this.parseIdentifier(!0);
      else
        switch (type) {
          case tt.num:
            key = this.parseNumericLiteral(value);
            break;
          case tt.string:
            key = this.parseStringLiteral(value);
            break;
          case tt.bigint:
            key = this.parseBigIntLiteral(value);
            break;
          case tt.privateName: {
            const privateKeyLoc = this.state.startLoc;
            refExpressionErrors != null ? refExpressionErrors.privateKeyLoc === null && (refExpressionErrors.privateKeyLoc = privateKeyLoc) : this.raise(Errors.UnexpectedPrivateField, privateKeyLoc), key = this.parsePrivateName();
            break;
          }
          default:
            if (type === tt.decimal) {
              key = this.parseDecimalLiteral(value);
              break;
            }
            this.unexpected();
        }
      prop.key = key, type !== tt.privateName && (prop.computed = !1);
    }
  }
  initFunction(node, isAsync) {
    node.id = null, node.generator = !1, node.async = isAsync;
  }
  parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope = !1) {
    this.initFunction(node, isAsync), node.generator = isGenerator, this.scope.enter(ScopeFlag.FUNCTION | ScopeFlag.SUPER | (inClassScope ? ScopeFlag.CLASS : 0) | (allowDirectSuper ? ScopeFlag.DIRECT_SUPER : 0)), this.prodParam.enter(functionFlags(isAsync, node.generator)), this.parseFunctionParams(node, isConstructor);
    const finishedNode = this.parseFunctionBodyAndFinish(node, type, !0);
    return this.prodParam.exit(), this.scope.exit(), finishedNode;
  }
  parseArrayLike(close, isTuple, refExpressionErrors) {
    isTuple && this.expectPlugin("recordAndTuple");
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = !1;
    const node = this.startNode();
    return this.next(), node.elements = this.parseExprList(close, !isTuple, refExpressionErrors, node), this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody, this.finishNode(node, isTuple ? "TupleExpression" : "ArrayExpression");
  }
  parseArrowExpression(node, params, isAsync, trailingCommaLoc) {
    this.scope.enter(ScopeFlag.FUNCTION | ScopeFlag.ARROW);
    let flags = functionFlags(isAsync, !1);
    !this.match(tt.braceL) && this.prodParam.hasIn && (flags |= ParamKind.PARAM_IN), this.prodParam.enter(flags), this.initFunction(node, isAsync);
    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    return params && (this.state.maybeInArrowParameters = !0, this.setArrowFunctionParameters(node, params, trailingCommaLoc)), this.state.maybeInArrowParameters = !1, this.parseFunctionBody(node, !0), this.prodParam.exit(), this.scope.exit(), this.state.maybeInArrowParameters = oldMaybeInArrowParameters, this.finishNode(node, "ArrowFunctionExpression");
  }
  setArrowFunctionParameters(node, params, trailingCommaLoc) {
    this.toAssignableList(params, trailingCommaLoc, !1), node.params = params;
  }
  parseFunctionBodyAndFinish(node, type, isMethod = !1) {
    return this.parseFunctionBody(node, !1, isMethod), this.finishNode(node, type);
  }
  parseFunctionBody(node, allowExpression, isMethod = !1) {
    const isExpression = allowExpression && !this.match(tt.braceL);
    if (this.expressionScope.enter(newExpressionScope()), isExpression)
      node.body = this.parseMaybeAssign(), this.checkParams(node, !1, allowExpression, !1);
    else {
      const oldStrict = this.state.strict, oldLabels = this.state.labels;
      this.state.labels = [], this.prodParam.enter(this.prodParam.currentFlags() | ParamKind.PARAM_RETURN), node.body = this.parseBlock(!0, !1, (hasStrictModeDirective) => {
        const nonSimple = !this.isSimpleParamList(node.params);
        hasStrictModeDirective && nonSimple && this.raise(Errors.IllegalLanguageModeDirective, (node.kind === "method" || node.kind === "constructor") && node.key ? node.key.loc.end : node);
        const strictModeChanged = !oldStrict && this.state.strict;
        this.checkParams(node, !this.state.strict && !allowExpression && !isMethod && !nonSimple, allowExpression, strictModeChanged), this.state.strict && node.id && this.checkIdentifier(node.id, BindingFlag.TYPE_OUTSIDE, strictModeChanged);
      }), this.prodParam.exit(), this.state.labels = oldLabels;
    }
    this.expressionScope.exit();
  }
  isSimpleParameter(node) {
    return node.type === "Identifier";
  }
  isSimpleParamList(params) {
    for (let i = 0, len = params.length; i < len; i++)
      if (!this.isSimpleParameter(params[i])) return !1;
    return !0;
  }
  checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged = !0) {
    const checkClashes = !allowDuplicates && /* @__PURE__ */ new Set(), formalParameters = {
      type: "FormalParameters"
    };
    for (const param of node.params)
      this.checkLVal(param, formalParameters, BindingFlag.TYPE_VAR, checkClashes, strictModeChanged);
  }
  parseExprList(close, allowEmpty, refExpressionErrors, nodeForExtra) {
    const elts = [];
    let first = !0;
    for (; !this.eat(close); ) {
      if (first)
        first = !1;
      else if (this.expect(tt.comma), this.match(close)) {
        nodeForExtra && this.addTrailingCommaExtraToNode(nodeForExtra), this.next();
        break;
      }
      elts.push(this.parseExprListItem(close, allowEmpty, refExpressionErrors));
    }
    return elts;
  }
  parseExprListItem(close, allowEmpty, refExpressionErrors, allowPlaceholder) {
    let elt;
    if (this.match(tt.comma))
      allowEmpty || this.raise(Errors.UnexpectedToken, this.state.curPosition(), {
        unexpected: ","
      }), elt = null;
    else if (this.match(tt.ellipsis)) {
      const spreadNodeStartLoc = this.state.startLoc;
      elt = this.parseParenItem(this.parseSpread(refExpressionErrors), spreadNodeStartLoc);
    } else if (this.match(tt.question)) {
      this.expectPlugin("partialApplication"), allowPlaceholder || this.raise(Errors.UnexpectedArgumentPlaceholder, this.state.startLoc);
      const node = this.startNode();
      this.next(), elt = this.finishNode(node, "ArgumentPlaceholder");
    } else
      elt = this.parseMaybeAssignAllowInOrVoidPattern(close, refExpressionErrors, this.parseParenItem);
    return elt;
  }
  parseIdentifier(liberal) {
    const node = this.startNode(), name = this.parseIdentifierName(liberal);
    return this.createIdentifier(node, name);
  }
  createIdentifier(node, name) {
    return node.name = name, node.loc.identifierName = name, this.finishNode(node, "Identifier");
  }
  createIdentifierAt(node, name, endLoc) {
    return node.name = name, node.loc.identifierName = name, this.finishNodeAt(node, "Identifier", endLoc);
  }
  parseIdentifierName(liberal) {
    let name;
    const {
      startLoc,
      type
    } = this.state;
    tokenIsKeywordOrIdentifier(type) ? name = this.state.value : this.unexpected();
    const tokenIsKeyword = tokenKeywordOrIdentifierIsKeyword(type);
    return liberal ? tokenIsKeyword && this.replaceToken(tt.name) : this.checkReservedWord(name, startLoc, tokenIsKeyword, !1), this.next(), name;
  }
  checkReservedWord(word, startLoc, checkKeywords, isBinding) {
    if (word.length > 10 || !canBeReservedWord(word))
      return;
    if (checkKeywords && isKeyword(word)) {
      this.raise(Errors.UnexpectedKeyword, startLoc, {
        keyword: word
      });
      return;
    }
    if ((this.state.strict ? isBinding ? isStrictBindReservedWord : isStrictReservedWord : isReservedWord)(word, this.inModule)) {
      this.raise(Errors.UnexpectedReservedWord, startLoc, {
        reservedWord: word
      });
      return;
    } else if (word === "yield") {
      if (this.prodParam.hasYield) {
        this.raise(Errors.YieldBindingIdentifier, startLoc);
        return;
      }
    } else if (word === "await") {
      if (this.prodParam.hasAwait) {
        this.raise(Errors.AwaitBindingIdentifier, startLoc);
        return;
      }
      if (this.scope.inStaticBlock) {
        this.raise(Errors.AwaitBindingIdentifierInStaticBlock, startLoc);
        return;
      }
      this.expressionScope.recordAsyncArrowParametersError(startLoc);
    } else if (word === "arguments" && this.scope.inClassAndNotInNonArrowFunction) {
      this.raise(Errors.ArgumentsInClass, startLoc);
      return;
    }
  }
  recordAwaitIfAllowed() {
    const isAwaitAllowed = this.prodParam.hasAwait;
    return isAwaitAllowed && !this.scope.inFunction && (this.state.hasTopLevelAwait = !0), isAwaitAllowed;
  }
  parseAwait(startLoc) {
    const node = this.startNodeAt(startLoc);
    return this.expressionScope.recordParameterInitializerError(Errors.AwaitExpressionFormalParameter, node), this.eat(tt.star) && this.raise(Errors.ObsoleteAwaitStar, node), !this.scope.inFunction && !(this.optionFlags & OptionFlags.AllowAwaitOutsideFunction) && (this.isAmbiguousPrefixOrIdentifier() ? this.ambiguousScriptDifferentAst = !0 : this.sawUnambiguousESM = !0), this.state.soloAwait || (node.argument = this.parseMaybeUnary(null, !0)), this.finishNode(node, "AwaitExpression");
  }
  isAmbiguousPrefixOrIdentifier() {
    if (this.hasPrecedingLineBreak()) return !0;
    const {
      type
    } = this.state;
    return type === tt.plusMin || type === tt.parenL || type === tt.bracketL || tokenIsTemplate(type) || type === tt._of && !this.state.containsEsc || type === tt.regexp || type === tt.slash || this.hasPlugin("v8intrinsic") && type === tt.modulo;
  }
  parseYield(startLoc) {
    const node = this.startNodeAt(startLoc);
    this.expressionScope.recordParameterInitializerError(Errors.YieldInParameter, node);
    let delegating = !1, argument = null;
    if (!this.hasPrecedingLineBreak())
      switch (delegating = this.eat(tt.star), this.state.type) {
        case tt.semi:
        case tt.eof:
        case tt.braceR:
        case tt.parenR:
        case tt.bracketR:
        case tt.braceBarR:
        case tt.colon:
        case tt.comma:
          if (!delegating) break;
        default:
          argument = this.parseMaybeAssign();
      }
    return node.delegate = delegating, node.argument = argument, this.finishNode(node, "YieldExpression");
  }
  parseImportCall(node) {
    if (this.next(), node.source = this.parseMaybeAssignAllowIn(), node.options = null, this.eat(tt.comma)) {
      if (this.match(tt.parenR))
        this.addTrailingCommaExtraToNode(node.source);
      else if (node.options = this.parseMaybeAssignAllowIn(), this.eat(tt.comma) && (this.addTrailingCommaExtraToNode(node.options), !this.match(tt.parenR))) {
        do
          this.parseMaybeAssignAllowIn();
        while (this.eat(tt.comma) && !this.match(tt.parenR));
        this.raise(Errors.ImportCallArity, node);
      }
    }
    return this.expect(tt.parenR), this.finishNode(node, "ImportExpression");
  }
  checkPipelineAtInfixOperator(left, leftStartLoc) {
    this.hasPlugin(["pipelineOperator", {
      proposal: "smart"
    }]) && left.type === "SequenceExpression" && this.raise(Errors.PipelineHeadSequenceExpression, leftStartLoc);
  }
  parseSmartPipelineBodyInStyle(childExpr, startLoc) {
    if (this.isSimpleReference(childExpr)) {
      const bodyNode = this.startNodeAt(startLoc);
      return bodyNode.callee = childExpr, this.finishNode(bodyNode, "PipelineBareFunction");
    } else {
      const bodyNode = this.startNodeAt(startLoc);
      return this.checkSmartPipeTopicBodyEarlyErrors(startLoc), bodyNode.expression = childExpr, this.finishNode(bodyNode, "PipelineTopicExpression");
    }
  }
  isSimpleReference(expression) {
    switch (expression.type) {
      case "MemberExpression":
        return !expression.computed && this.isSimpleReference(expression.object);
      case "Identifier":
        return !0;
      default:
        return !1;
    }
  }
  checkSmartPipeTopicBodyEarlyErrors(startLoc) {
    if (this.match(tt.arrow))
      throw this.raise(Errors.PipelineBodyNoArrow, this.state.startLoc);
    this.topicReferenceWasUsedInCurrentContext() || this.raise(Errors.PipelineTopicUnused, startLoc);
  }
  withTopicBindingContext(callback) {
    const outerContextTopicState = this.state.topicContext;
    this.state.topicContext = {
      maxNumOfResolvableTopics: 1,
      maxTopicIndex: null
    };
    try {
      return callback();
    } finally {
      this.state.topicContext = outerContextTopicState;
    }
  }
  withSmartMixTopicForbiddingContext(callback) {
    if (this.hasPlugin(["pipelineOperator", {
      proposal: "smart"
    }])) {
      const outerContextTopicState = this.state.topicContext;
      this.state.topicContext = {
        maxNumOfResolvableTopics: 0,
        maxTopicIndex: null
      };
      try {
        return callback();
      } finally {
        this.state.topicContext = outerContextTopicState;
      }
    } else
      return callback();
  }
  withSoloAwaitPermittingContext(callback) {
    const outerContextSoloAwaitState = this.state.soloAwait;
    this.state.soloAwait = !0;
    try {
      return callback();
    } finally {
      this.state.soloAwait = outerContextSoloAwaitState;
    }
  }
  allowInAnd(callback) {
    const flags = this.prodParam.currentFlags();
    if (ParamKind.PARAM_IN & ~flags) {
      this.prodParam.enter(flags | ParamKind.PARAM_IN);
      try {
        return callback();
      } finally {
        this.prodParam.exit();
      }
    }
    return callback();
  }
  disallowInAnd(callback) {
    const flags = this.prodParam.currentFlags();
    if (ParamKind.PARAM_IN & flags) {
      this.prodParam.enter(flags & ~ParamKind.PARAM_IN);
      try {
        return callback();
      } finally {
        this.prodParam.exit();
      }
    }
    return callback();
  }
  registerTopicReference() {
    this.state.topicContext.maxTopicIndex = 0;
  }
  topicReferenceIsAllowedInCurrentContext() {
    return this.state.topicContext.maxNumOfResolvableTopics >= 1;
  }
  topicReferenceWasUsedInCurrentContext() {
    return this.state.topicContext.maxTopicIndex != null && this.state.topicContext.maxTopicIndex >= 0;
  }
  parseFSharpPipelineBody(prec) {
    const startLoc = this.state.startLoc;
    this.state.potentialArrowAt = this.state.start;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = !0;
    const ret = this.parseExprOp(this.parseMaybeUnaryOrPrivate(), startLoc, prec);
    return this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody, ret;
  }
  parseModuleExpression() {
    this.expectPlugin("moduleBlocks");
    const node = this.startNode();
    this.next(), this.match(tt.braceL) || this.unexpected(null, tt.braceL);
    const program = this.startNodeAt(this.state.endLoc);
    this.next();
    const revertScopes = this.initializeScopes(!0);
    this.enterInitialScopes();
    try {
      node.body = this.parseProgram(program, tt.braceR, "module");
    } finally {
      revertScopes();
    }
    return this.finishNode(node, "ModuleExpression");
  }
  parseVoidPattern(refExpressionErrors) {
    this.expectPlugin("discardBinding");
    const node = this.startNode();
    return refExpressionErrors != null && (refExpressionErrors.voidPatternLoc = this.state.startLoc), this.next(), this.finishNode(node, "VoidPattern");
  }
  parseMaybeAssignAllowInOrVoidPattern(close, refExpressionErrors, afterLeftParse) {
    if (refExpressionErrors != null && this.match(tt._void)) {
      const nextCode = this.lookaheadCharCode();
      if (nextCode === 44 || nextCode === (close === tt.bracketR ? 93 : close === tt.braceR ? 125 : 41) || nextCode === 61)
        return this.parseMaybeDefault(this.state.startLoc, this.parseVoidPattern(refExpressionErrors));
    }
    return this.parseMaybeAssignAllowIn(refExpressionErrors, afterLeftParse);
  }
  parsePropertyNamePrefixOperator(prop) {
  }
}
export {
  ExpressionParser as default
};
