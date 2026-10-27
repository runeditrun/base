// Generated from Babel v7.29.8 (MIT); see README.md.
import { tt } from "../tokenizer/types.mjs";
import { isStrictBindOnlyReservedWord, isStrictBindReservedWord } from "../util/identifier.mjs";
import { NodeUtils } from "./node.mjs";
import { BindingFlag } from "../util/scopeflags.mjs";
import { Errors } from "../parse-error.mjs";
import { OptionFlags } from "../options.mjs";
const unwrapParenthesizedExpression = (node) => node.type === "ParenthesizedExpression" ? unwrapParenthesizedExpression(node.expression) : node;
var ParseBindingListFlags = {
  ALLOW_EMPTY: 1,
  IS_FUNCTION_PARAMS: 2,
  IS_CONSTRUCTOR_PARAMS: 4
};
class LValParser extends NodeUtils {
  toAssignable(node, isLHS = !1) {
    let parenthesized;
    switch ((node.type === "ParenthesizedExpression" || node.extra?.parenthesized) && (parenthesized = unwrapParenthesizedExpression(node), isLHS ? parenthesized.type === "Identifier" ? this.expressionScope.recordArrowParameterBindingError(Errors.InvalidParenthesizedAssignment, node) : parenthesized.type !== "CallExpression" && parenthesized.type !== "MemberExpression" && !this.isOptionalMemberExpression(parenthesized) && this.raise(Errors.InvalidParenthesizedAssignment, node) : this.raise(Errors.InvalidParenthesizedAssignment, node)), node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
      case "VoidPattern":
        break;
      case "ObjectExpression":
        this.castNodeTo(node, "ObjectPattern");
        for (let i = 0, length = node.properties.length, last = length - 1; i < length; i++) {
          const prop = node.properties[i], isLast = i === last;
          this.toAssignableObjectExpressionProp(prop, isLast, isLHS), isLast && prop.type === "RestElement" && node.extra?.trailingCommaLoc && this.raise(Errors.RestTrailingComma, node.extra.trailingCommaLoc);
        }
        break;
      case "ObjectProperty": {
        const {
          key,
          value
        } = node;
        this.isPrivateName(key) && this.classScope.usePrivateName(this.getPrivateNameSV(key), key.loc.start), this.toAssignable(value, isLHS);
        break;
      }
      case "SpreadElement":
        throw new Error("Internal @babel/parser error (this is a bug, please report it). SpreadElement should be converted by .toAssignable's caller.");
      case "ArrayExpression":
        this.castNodeTo(node, "ArrayPattern"), this.toAssignableList(node.elements, node.extra?.trailingCommaLoc, isLHS);
        break;
      case "AssignmentExpression":
        node.operator !== "=" && this.raise(Errors.MissingEqInAssignment, node.left.loc.end), this.castNodeTo(node, "AssignmentPattern"), delete node.operator, node.left.type === "VoidPattern" && this.raise(Errors.VoidPatternInitializer, node.left), this.toAssignable(node.left, isLHS);
        break;
      case "ParenthesizedExpression":
        this.toAssignable(parenthesized, isLHS);
        break;
      default:
    }
  }
  toAssignableObjectExpressionProp(prop, isLast, isLHS) {
    if (prop.type === "ObjectMethod")
      this.raise(prop.kind === "get" || prop.kind === "set" ? Errors.PatternHasAccessor : Errors.PatternHasMethod, prop.key);
    else if (prop.type === "SpreadElement") {
      this.castNodeTo(prop, "RestElement");
      const arg = prop.argument;
      this.checkToRestConversion(arg, !1), this.toAssignable(arg, isLHS), isLast || this.raise(Errors.RestTrailingComma, prop);
    } else
      this.toAssignable(prop, isLHS);
  }
  toAssignableList(exprList, trailingCommaLoc, isLHS) {
    const end = exprList.length - 1;
    for (let i = 0; i <= end; i++) {
      const elt = exprList[i];
      elt && (this.toAssignableListItem(exprList, i, isLHS), elt.type === "RestElement" && (i < end ? this.raise(Errors.RestTrailingComma, elt) : trailingCommaLoc && this.raise(Errors.RestTrailingComma, trailingCommaLoc)));
    }
  }
  toAssignableListItem(exprList, index, isLHS) {
    const node = exprList[index];
    if (node.type === "SpreadElement") {
      this.castNodeTo(node, "RestElement");
      const arg = node.argument;
      this.checkToRestConversion(arg, !0), this.toAssignable(arg, isLHS);
    } else
      this.toAssignable(node, isLHS);
  }
  isAssignable(node, isBinding) {
    switch (node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
      case "VoidPattern":
        return !0;
      case "ObjectExpression": {
        const last = node.properties.length - 1;
        return node.properties.every((prop, i) => prop.type !== "ObjectMethod" && (i === last || prop.type !== "SpreadElement") && this.isAssignable(prop));
      }
      case "ObjectProperty":
        return this.isAssignable(node.value);
      case "SpreadElement":
        return this.isAssignable(node.argument);
      case "ArrayExpression":
        return node.elements.every((element) => element === null || this.isAssignable(element));
      case "AssignmentExpression":
        return node.operator === "=";
      case "ParenthesizedExpression":
        return this.isAssignable(node.expression);
      case "MemberExpression":
      case "OptionalMemberExpression":
        return !isBinding;
      default:
        return !1;
    }
  }
  toReferencedList(exprList, isParenthesizedExpr) {
    return exprList;
  }
  toReferencedListDeep(exprList, isParenthesizedExpr) {
    this.toReferencedList(exprList, isParenthesizedExpr);
    for (const expr of exprList)
      expr?.type === "ArrayExpression" && this.toReferencedListDeep(expr.elements);
  }
  parseSpread(refExpressionErrors) {
    const node = this.startNode();
    return this.next(), node.argument = this.parseMaybeAssignAllowIn(refExpressionErrors, void 0), this.finishNode(node, "SpreadElement");
  }
  parseRestBinding() {
    const node = this.startNode();
    this.next();
    const argument = this.parseBindingAtom();
    return argument.type === "VoidPattern" && this.raise(Errors.UnexpectedVoidPattern, argument), node.argument = argument, this.finishNode(node, "RestElement");
  }
  parseBindingAtom() {
    switch (this.state.type) {
      case tt.bracketL: {
        const node = this.startNode();
        return this.next(), node.elements = this.parseBindingList(tt.bracketR, 93, ParseBindingListFlags.ALLOW_EMPTY), this.finishNode(node, "ArrayPattern");
      }
      case tt.braceL:
        return this.parseObjectLike(tt.braceR, !0);
      case tt._void:
        return this.parseVoidPattern(null);
    }
    return this.parseIdentifier();
  }
  parseBindingList(close, closeCharCode, flags) {
    const allowEmpty = flags & ParseBindingListFlags.ALLOW_EMPTY, elts = [];
    let first = !0;
    for (; !this.eat(close); )
      if (first ? first = !1 : this.expect(tt.comma), allowEmpty && this.match(tt.comma))
        elts.push(null);
      else {
        if (this.eat(close))
          break;
        if (this.match(tt.ellipsis)) {
          let rest = this.parseRestBinding();
          if ((this.hasPlugin("flow") || flags & ParseBindingListFlags.IS_FUNCTION_PARAMS) && (rest = this.parseFunctionParamType(rest)), elts.push(rest), !this.checkCommaAfterRest(closeCharCode)) {
            this.expect(close);
            break;
          }
        } else {
          const decorators = [];
          if (flags & ParseBindingListFlags.IS_FUNCTION_PARAMS)
            for (this.match(tt.at) && this.hasPlugin("decorators") && this.raise(Errors.UnsupportedParameterDecorator, this.state.startLoc); this.match(tt.at); )
              decorators.push(this.parseDecorator());
          elts.push(this.parseBindingElement(flags, decorators));
        }
      }
    return elts;
  }
  parseBindingRestProperty(prop) {
    return this.next(), this.hasPlugin("discardBinding") && this.match(tt._void) ? (prop.argument = this.parseVoidPattern(null), this.raise(Errors.UnexpectedVoidPattern, prop.argument)) : prop.argument = this.parseIdentifier(), this.checkCommaAfterRest(125), this.finishNode(prop, "RestElement");
  }
  parseBindingProperty() {
    const {
      type,
      startLoc
    } = this.state;
    if (type === tt.ellipsis)
      return this.parseBindingRestProperty(this.startNode());
    const prop = this.startNode();
    return type === tt.privateName ? (this.expectPlugin("destructuringPrivate", startLoc), this.classScope.usePrivateName(this.state.value, startLoc), prop.key = this.parsePrivateName()) : this.parsePropertyName(prop), prop.method = !1, this.parseObjPropValue(prop, startLoc, !1, !1, !0, !1);
  }
  parseBindingElement(flags, decorators) {
    const left = this.parseMaybeDefault();
    return (this.hasPlugin("flow") || flags & ParseBindingListFlags.IS_FUNCTION_PARAMS) && this.parseFunctionParamType(left), decorators.length && (left.decorators = decorators, this.resetStartLocationFromNode(left, decorators[0])), this.parseMaybeDefault(left.loc.start, left);
  }
  parseFunctionParamType(param) {
    return param;
  }
  parseMaybeDefault(startLoc, left) {
    if (startLoc ??= this.state.startLoc, left = left ?? this.parseBindingAtom(), !this.eat(tt.eq)) return left;
    const node = this.startNodeAt(startLoc);
    return left.type === "VoidPattern" && this.raise(Errors.VoidPatternInitializer, left), node.left = left, node.right = this.parseMaybeAssignAllowIn(), this.finishNode(node, "AssignmentPattern");
  }
  isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
    switch (type) {
      case "AssignmentPattern":
        return "left";
      case "RestElement":
        return "argument";
      case "ObjectProperty":
        return "value";
      case "ParenthesizedExpression":
        return "expression";
      case "ArrayPattern":
        return "elements";
      case "ObjectPattern":
        return "properties";
      case "VoidPattern":
        return !0;
      case "CallExpression":
        if (!disallowCallExpression && !this.state.strict && this.optionFlags & OptionFlags.AnnexB)
          return !0;
    }
    return !1;
  }
  isOptionalMemberExpression(expression) {
    return expression.type === "OptionalMemberExpression";
  }
  checkLVal(expression, ancestor, binding = BindingFlag.TYPE_NONE, checkClashes = !1, strictModeChanged = !1, hasParenthesizedAncestor = !1, disallowCallExpression = !1) {
    const type = expression.type;
    if (this.isObjectMethod(expression)) return;
    const isOptionalMemberExpression = this.isOptionalMemberExpression(expression);
    if (isOptionalMemberExpression || type === "MemberExpression") {
      isOptionalMemberExpression && (this.expectPlugin("optionalChainingAssign", expression.loc.start), ancestor.type !== "AssignmentExpression" && this.raise(Errors.InvalidLhsOptionalChaining, expression, {
        ancestor
      })), binding !== BindingFlag.TYPE_NONE && this.raise(Errors.InvalidPropertyBindingPattern, expression);
      return;
    }
    if (type === "Identifier") {
      this.checkIdentifier(expression, binding, strictModeChanged);
      const {
        name
      } = expression;
      checkClashes && (checkClashes.has(name) ? this.raise(Errors.ParamDupe, expression) : checkClashes.add(name));
      return;
    } else type === "VoidPattern" && ancestor.type === "CatchClause" && this.raise(Errors.VoidPatternCatchClauseParam, expression);
    const unwrappedExpression = unwrapParenthesizedExpression(expression);
    disallowCallExpression ||= unwrappedExpression.type === "CallExpression" && (unwrappedExpression.callee.type === "Import" || unwrappedExpression.callee.type === "Super");
    const validity = this.isValidLVal(type, disallowCallExpression, !(hasParenthesizedAncestor || expression.extra?.parenthesized) && ancestor.type === "AssignmentExpression", binding);
    if (validity === !0) return;
    if (validity === !1) {
      const ParseErrorClass = binding === BindingFlag.TYPE_NONE ? Errors.InvalidLhs : Errors.InvalidLhsBinding;
      this.raise(ParseErrorClass, expression, {
        ancestor
      });
      return;
    }
    let key, isParenthesizedExpression;
    typeof validity == "string" ? (key = validity, isParenthesizedExpression = type === "ParenthesizedExpression") : [key, isParenthesizedExpression] = validity;
    const nextAncestor = type === "ArrayPattern" || type === "ObjectPattern" ? {
      type
    } : ancestor, val = expression[key];
    if (Array.isArray(val))
      for (const child of val)
        child && this.checkLVal(child, nextAncestor, binding, checkClashes, strictModeChanged, isParenthesizedExpression, !0);
    else val && this.checkLVal(val, nextAncestor, binding, checkClashes, strictModeChanged, isParenthesizedExpression, disallowCallExpression);
  }
  checkIdentifier(at, bindingType, strictModeChanged = !1) {
    this.state.strict && (strictModeChanged ? isStrictBindReservedWord(at.name, this.inModule) : isStrictBindOnlyReservedWord(at.name)) && (bindingType === BindingFlag.TYPE_NONE ? this.raise(Errors.StrictEvalArguments, at, {
      referenceName: at.name
    }) : this.raise(Errors.StrictEvalArgumentsBinding, at, {
      bindingName: at.name
    })), bindingType & BindingFlag.FLAG_NO_LET_IN_LEXICAL && at.name === "let" && this.raise(Errors.LetInLexicalBinding, at), bindingType & BindingFlag.TYPE_NONE || this.declareNameFromIdentifier(at, bindingType);
  }
  declareNameFromIdentifier(identifier, binding) {
    this.scope.declareName(identifier.name, binding, identifier.loc.start);
  }
  checkToRestConversion(node, allowPattern) {
    switch (node.type) {
      case "ParenthesizedExpression":
        this.checkToRestConversion(node.expression, allowPattern);
        break;
      case "Identifier":
      case "MemberExpression":
        break;
      case "ArrayExpression":
      case "ObjectExpression":
        if (allowPattern) break;
      default:
        this.raise(Errors.InvalidRestAssignmentPattern, node);
    }
  }
  checkCommaAfterRest(close) {
    return this.match(tt.comma) ? (this.raise(this.lookaheadCharCode() === close ? Errors.RestTrailingComma : Errors.ElementAfterRest, this.state.startLoc), !0) : !1;
  }
}
export {
  ParseBindingListFlags,
  LValParser as default
};
