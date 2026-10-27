// Generated from Babel v7.29.8 (MIT); see README.md.
import { Errors } from "../parse-error.mjs";
import { OptionFlags } from "../options.mjs";
const {
  defineProperty
} = Object, toUnenumerable = (object, key) => {
  object && defineProperty(object, key, {
    enumerable: !1,
    value: object[key]
  });
};
function toESTreeLocation(node) {
  return toUnenumerable(node.loc.start, "index"), toUnenumerable(node.loc.end, "index"), node;
}
var stdin_default = (superClass) => class extends superClass {
  parse() {
    const file = toESTreeLocation(super.parse());
    return this.optionFlags & OptionFlags.Tokens && (file.tokens = file.tokens.map(toESTreeLocation)), file;
  }
  parseRegExpLiteral({
    pattern,
    flags
  }) {
    let regex = null;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
    }
    const node = this.estreeParseLiteral(regex);
    return node.regex = {
      pattern,
      flags
    }, node;
  }
  parseBigIntLiteral(value) {
    let bigInt;
    try {
      bigInt = BigInt(value);
    } catch {
      bigInt = null;
    }
    const node = this.estreeParseLiteral(bigInt);
    return node.bigint = String(node.value || value), node;
  }
  parseDecimalLiteral(value) {
    const node = this.estreeParseLiteral(null);
    return node.decimal = String(node.value || value), node;
  }
  estreeParseLiteral(value) {
    return this.parseLiteral(value, "Literal");
  }
  parseStringLiteral(value) {
    return this.estreeParseLiteral(value);
  }
  parseNumericLiteral(value) {
    return this.estreeParseLiteral(value);
  }
  parseNullLiteral() {
    return this.estreeParseLiteral(null);
  }
  parseBooleanLiteral(value) {
    return this.estreeParseLiteral(value);
  }
  estreeParseChainExpression(node, endLoc) {
    const chain = this.startNodeAtNode(node);
    return chain.expression = node, this.finishNodeAt(chain, "ChainExpression", endLoc);
  }
  directiveToStmt(directive) {
    const expression = directive.value;
    delete directive.value, this.castNodeTo(expression, "Literal"), expression.raw = expression.extra.raw, expression.value = expression.extra.expressionValue;
    const stmt = this.castNodeTo(directive, "ExpressionStatement");
    return stmt.expression = expression, stmt.directive = expression.extra.rawValue, delete expression.extra, stmt;
  }
  fillOptionalPropertiesForTSESLint(node) {
  }
  cloneEstreeStringLiteral(node) {
    const {
      start,
      end,
      loc,
      range,
      raw,
      value
    } = node, cloned = Object.create(node.constructor.prototype);
    return cloned.type = "Literal", cloned.start = start, cloned.end = end, cloned.loc = loc, cloned.range = range, cloned.raw = raw, cloned.value = value, cloned;
  }
  initFunction(node, isAsync) {
    super.initFunction(node, isAsync), node.expression = !1;
  }
  checkDeclaration(node) {
    node != null && this.isObjectProperty(node) ? this.checkDeclaration(node.value) : super.checkDeclaration(node);
  }
  getObjectOrClassMethodParams(method) {
    return method.value.params;
  }
  isValidDirective(stmt) {
    return stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && typeof stmt.expression.value == "string" && !stmt.expression.extra?.parenthesized;
  }
  parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse) {
    super.parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse);
    const directiveStatements = node.directives.map((d) => this.directiveToStmt(d));
    node.body = directiveStatements.concat(node.body), delete node.directives;
  }
  parsePrivateName() {
    const node = super.parsePrivateName();
    return this.getPluginOption("estree", "classFeatures") ? this.convertPrivateNameToPrivateIdentifier(node) : node;
  }
  convertPrivateNameToPrivateIdentifier(node) {
    const name = super.getPrivateNameSV(node);
    return delete node.id, node.name = name, this.castNodeTo(node, "PrivateIdentifier");
  }
  isPrivateName(node) {
    return this.getPluginOption("estree", "classFeatures") ? node.type === "PrivateIdentifier" : super.isPrivateName(node);
  }
  getPrivateNameSV(node) {
    return this.getPluginOption("estree", "classFeatures") ? node.name : super.getPrivateNameSV(node);
  }
  parseLiteral(value, type) {
    const node = super.parseLiteral(value, type);
    return node.raw = node.extra.raw, delete node.extra, node;
  }
  parseFunctionBody(node, allowExpression, isMethod = !1) {
    super.parseFunctionBody(node, allowExpression, isMethod), node.expression = node.body.type !== "BlockStatement";
  }
  parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope = !1) {
    let funcNode = this.startNode();
    funcNode.kind = node.kind, funcNode = super.parseMethod(funcNode, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope), delete funcNode.kind;
    const {
      typeParameters
    } = node;
    typeParameters && (delete node.typeParameters, funcNode.typeParameters = typeParameters, this.resetStartLocationFromNode(funcNode, typeParameters));
    const valueNode = this.castNodeTo(funcNode, "FunctionExpression");
    return node.value = valueNode, type === "ClassPrivateMethod" && (node.computed = !1), type === "ObjectMethod" ? (node.kind === "method" && (node.kind = "init"), node.shorthand = !1, this.finishNode(node, "Property")) : this.finishNode(node, "MethodDefinition");
  }
  nameIsConstructor(key) {
    return key.type === "Literal" ? key.value === "constructor" : super.nameIsConstructor(key);
  }
  parseClassProperty(...args) {
    const propertyNode = super.parseClassProperty(...args);
    return this.getPluginOption("estree", "classFeatures") && this.castNodeTo(propertyNode, "PropertyDefinition"), propertyNode;
  }
  parseClassPrivateProperty(...args) {
    const propertyNode = super.parseClassPrivateProperty(...args);
    return this.getPluginOption("estree", "classFeatures") && (this.castNodeTo(propertyNode, "PropertyDefinition"), propertyNode.computed = !1), propertyNode;
  }
  parseClassAccessorProperty(node) {
    const accessorPropertyNode = super.parseClassAccessorProperty(node);
    return this.getPluginOption("estree", "classFeatures") && (accessorPropertyNode.abstract && this.hasPlugin("typescript") ? (delete accessorPropertyNode.abstract, this.castNodeTo(accessorPropertyNode, "TSAbstractAccessorProperty")) : this.castNodeTo(accessorPropertyNode, "AccessorProperty")), accessorPropertyNode;
  }
  parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors) {
    const node = super.parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors);
    return node && (node.kind = "init", this.castNodeTo(node, "Property")), node;
  }
  finishObjectProperty(node) {
    return node.kind = "init", this.finishNode(node, "Property");
  }
  isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
    return type === "Property" ? "value" : super.isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding);
  }
  isAssignable(node, isBinding) {
    return node != null && this.isObjectProperty(node) ? this.isAssignable(node.value, isBinding) : super.isAssignable(node, isBinding);
  }
  toAssignable(node, isLHS = !1) {
    if (node != null && this.isObjectProperty(node)) {
      const {
        key,
        value
      } = node;
      this.isPrivateName(key) && this.classScope.usePrivateName(this.getPrivateNameSV(key), key.loc.start), this.toAssignable(value, isLHS);
    } else
      super.toAssignable(node, isLHS);
  }
  toAssignableObjectExpressionProp(prop, isLast, isLHS) {
    prop.type === "Property" && (prop.kind === "get" || prop.kind === "set") ? this.raise(Errors.PatternHasAccessor, prop.key) : prop.type === "Property" && prop.method ? this.raise(Errors.PatternHasMethod, prop.key) : super.toAssignableObjectExpressionProp(prop, isLast, isLHS);
  }
  finishCallExpression(unfinished, optional) {
    const node = super.finishCallExpression(unfinished, optional);
    return node.callee.type === "Import" ? (this.castNodeTo(node, "ImportExpression"), node.source = node.arguments[0], node.options = node.arguments[1] ?? null, node.attributes = node.arguments[1] ?? null, delete node.arguments, delete node.callee) : node.type === "OptionalCallExpression" ? this.castNodeTo(node, "CallExpression") : node.optional = !1, node;
  }
  toReferencedArguments(node) {
    node.type !== "ImportExpression" && super.toReferencedArguments(node);
  }
  parseExport(unfinished, decorators) {
    const exportStartLoc = this.state.lastTokStartLoc, node = super.parseExport(unfinished, decorators);
    switch (node.type) {
      case "ExportAllDeclaration":
        node.exported = null;
        break;
      case "ExportNamedDeclaration":
        node.specifiers.length === 1 && node.specifiers[0].type === "ExportNamespaceSpecifier" && (this.castNodeTo(node, "ExportAllDeclaration"), node.exported = node.specifiers[0].exported, delete node.specifiers);
      case "ExportDefaultDeclaration":
        {
          const {
            declaration
          } = node;
          declaration?.type === "ClassDeclaration" && declaration.decorators?.length > 0 && declaration.start === node.start && this.resetStartLocation(node, exportStartLoc);
        }
        break;
    }
    return node;
  }
  stopParseSubscript(base, state) {
    const node = super.stopParseSubscript(base, state);
    return state.optionalChainMember ? this.estreeParseChainExpression(node, base.loc.end) : node;
  }
  parseMember(base, startLoc, state, computed, optional) {
    const node = super.parseMember(base, startLoc, state, computed, optional);
    return node.type === "OptionalMemberExpression" ? this.castNodeTo(node, "MemberExpression") : node.optional = !1, node;
  }
  isOptionalMemberExpression(node) {
    return node.type === "ChainExpression" ? node.expression.type === "MemberExpression" : super.isOptionalMemberExpression(node);
  }
  hasPropertyAsPrivateName(node) {
    return node.type === "ChainExpression" && (node = node.expression), super.hasPropertyAsPrivateName(node);
  }
  isObjectProperty(node) {
    return node.type === "Property" && node.kind === "init" && !node.method;
  }
  isObjectMethod(node) {
    return node.type === "Property" && (node.method || node.kind === "get" || node.kind === "set");
  }
  castNodeTo(node, type) {
    const result = super.castNodeTo(node, type);
    return this.fillOptionalPropertiesForTSESLint(result), result;
  }
  cloneIdentifier(node) {
    const cloned = super.cloneIdentifier(node);
    return this.fillOptionalPropertiesForTSESLint(cloned), cloned;
  }
  cloneStringLiteral(node) {
    return node.type === "Literal" ? this.cloneEstreeStringLiteral(node) : super.cloneStringLiteral(node);
  }
  finishNodeAt(node, type, endLoc) {
    return toESTreeLocation(super.finishNodeAt(node, type, endLoc));
  }
  finishNode(node, type) {
    const result = super.finishNode(node, type);
    return this.fillOptionalPropertiesForTSESLint(result), result;
  }
  resetStartLocation(node, startLoc) {
    super.resetStartLocation(node, startLoc), toESTreeLocation(node);
  }
  resetEndLocation(node, endLoc = this.state.lastTokEndLoc) {
    super.resetEndLocation(node, endLoc), toESTreeLocation(node);
  }
};
export {
  stdin_default as default
};
