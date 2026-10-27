// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenIsIdentifier, tokenIsKeyword, tokenIsKeywordOrIdentifier, tokenIsLiteralPropertyName, tokenLabelName, tt, tokenIsFlowInterfaceOrTypeOrOpaque } from "../../tokenizer/types.mjs";
import { types as tc } from "../../tokenizer/context.mjs";
import { isIteratorStart } from "../../util/identifier.mjs";
import FlowScopeHandler from "./scope.mjs";
import { BindingFlag, ScopeFlag } from "../../util/scopeflags.mjs";
import { Errors, ParseErrorEnum } from "../../parse-error.mjs";
const reservedTypes = /* @__PURE__ */ new Set(["_", "any", "bool", "boolean", "empty", "extends", "false", "interface", "mixed", "null", "number", "static", "string", "true", "typeof", "void"]), FlowErrors = ParseErrorEnum`flow`({
  AmbiguousConditionalArrow: "Ambiguous expression: wrap the arrow functions in parentheses to disambiguate.",
  AmbiguousDeclareModuleKind: "Found both `declare module.exports` and `declare export` in the same module. Modules can only have 1 since they are either an ES module or they are a CommonJS module.",
  AssignReservedType: ({
    reservedType
  }) => `Cannot overwrite reserved type ${reservedType}.`,
  DeclareClassElement: "The `declare` modifier can only appear on class fields.",
  DeclareClassFieldInitializer: "Initializers are not allowed in fields with the `declare` modifier.",
  DuplicateDeclareModuleExports: "Duplicate `declare module.exports` statement.",
  EnumBooleanMemberNotInitialized: ({
    memberName,
    enumName
  }) => `Boolean enum members need to be initialized. Use either \`${memberName} = true,\` or \`${memberName} = false,\` in enum \`${enumName}\`.`,
  EnumDuplicateMemberName: ({
    memberName,
    enumName
  }) => `Enum member names need to be unique, but the name \`${memberName}\` has already been used before in enum \`${enumName}\`.`,
  EnumInconsistentMemberValues: ({
    enumName
  }) => `Enum \`${enumName}\` has inconsistent member initializers. Either use no initializers, or consistently use literals (either booleans, numbers, or strings) for all member initializers.`,
  EnumInvalidExplicitType: ({
    invalidEnumType,
    enumName
  }) => `Enum type \`${invalidEnumType}\` is not valid. Use one of \`boolean\`, \`number\`, \`string\`, or \`symbol\` in enum \`${enumName}\`.`,
  EnumInvalidExplicitTypeUnknownSupplied: ({
    enumName
  }) => `Supplied enum type is not valid. Use one of \`boolean\`, \`number\`, \`string\`, or \`symbol\` in enum \`${enumName}\`.`,
  EnumInvalidMemberInitializerPrimaryType: ({
    enumName,
    memberName,
    explicitType
  }) => `Enum \`${enumName}\` has type \`${explicitType}\`, so the initializer of \`${memberName}\` needs to be a ${explicitType} literal.`,
  EnumInvalidMemberInitializerSymbolType: ({
    enumName,
    memberName
  }) => `Symbol enum members cannot be initialized. Use \`${memberName},\` in enum \`${enumName}\`.`,
  EnumInvalidMemberInitializerUnknownType: ({
    enumName,
    memberName
  }) => `The enum member initializer for \`${memberName}\` needs to be a literal (either a boolean, number, or string) in enum \`${enumName}\`.`,
  EnumInvalidMemberName: ({
    enumName,
    memberName,
    suggestion
  }) => `Enum member names cannot start with lowercase 'a' through 'z'. Instead of using \`${memberName}\`, consider using \`${suggestion}\`, in enum \`${enumName}\`.`,
  EnumNumberMemberNotInitialized: ({
    enumName,
    memberName
  }) => `Number enum members need to be initialized, e.g. \`${memberName} = 1\` in enum \`${enumName}\`.`,
  EnumStringMemberInconsistentlyInitialized: ({
    enumName
  }) => `String enum members need to consistently either all use initializers, or use no initializers, in enum \`${enumName}\`.`,
  GetterMayNotHaveThisParam: "A getter cannot have a `this` parameter.",
  ImportReflectionHasImportType: "An `import module` declaration can not use `type` or `typeof` keyword.",
  ImportTypeShorthandOnlyInPureImport: "The `type` and `typeof` keywords on named imports can only be used on regular `import` statements. It cannot be used with `import type` or `import typeof` statements.",
  InexactInsideExact: "Explicit inexact syntax cannot appear inside an explicit exact object type.",
  InexactInsideNonObject: "Explicit inexact syntax cannot appear in class or interface definitions.",
  InexactVariance: "Explicit inexact syntax cannot have variance.",
  InvalidNonTypeImportInDeclareModule: "Imports within a `declare module` body must always be `import type` or `import typeof`.",
  MissingTypeParamDefault: "Type parameter declaration needs a default, since a preceding type parameter declaration has a default.",
  NestedDeclareModule: "`declare module` cannot be used inside another `declare module`.",
  NestedFlowComment: "Cannot have a flow comment inside another flow comment.",
  PatternIsOptional: {
    message: "A binding pattern parameter cannot be optional in an implementation signature.",
    reasonCode: "OptionalBindingPattern"
  },
  SetterMayNotHaveThisParam: "A setter cannot have a `this` parameter.",
  SpreadVariance: "Spread properties cannot have variance.",
  ThisParamAnnotationRequired: "A type annotation is required for the `this` parameter.",
  ThisParamBannedInConstructor: "Constructors cannot have a `this` parameter; constructors don't bind `this` like other functions.",
  ThisParamMayNotBeOptional: "The `this` parameter cannot be optional.",
  ThisParamMustBeFirst: "The `this` parameter must be the first function parameter.",
  ThisParamNoDefault: "The `this` parameter may not have a default value.",
  TypeBeforeInitializer: "Type annotations must come before default assignments, e.g. instead of `age = 25: number` use `age: number = 25`.",
  TypeCastInPattern: "The type cast expression is expected to be wrapped with parenthesis.",
  UnexpectedExplicitInexactInObject: "Explicit inexact syntax must appear at the end of an inexact object.",
  UnexpectedReservedType: ({
    reservedType
  }) => `Unexpected reserved type ${reservedType}.`,
  UnexpectedReservedUnderscore: "`_` is only allowed as a type argument to call or new.",
  UnexpectedSpaceBetweenModuloChecks: "Spaces between `%` and `checks` are not allowed here.",
  UnexpectedSpreadType: "Spread operator cannot appear in class or interface definitions.",
  UnexpectedSubtractionOperand: 'Unexpected token, expected "number" or "bigint".',
  UnexpectedTokenAfterTypeParameter: "Expected an arrow function after this type parameter declaration.",
  UnexpectedTypeParameterBeforeAsyncArrowFunction: "Type parameters must come after the async keyword, e.g. instead of `<T> async () => {}`, use `async <T>() => {}`.",
  UnsupportedDeclareExportKind: ({
    unsupportedExportKind,
    suggestion
  }) => `\`declare export ${unsupportedExportKind}\` is not supported. Use \`${suggestion}\` instead.`,
  UnsupportedStatementInDeclareModule: "Only declares and type imports are allowed inside declare module.",
  UnterminatedFlowComment: "Unterminated flow-comment."
});
function isEsModuleType(bodyElement) {
  return bodyElement.type === "DeclareExportAllDeclaration" || bodyElement.type === "DeclareExportDeclaration" && (!bodyElement.declaration || bodyElement.declaration.type !== "TypeAlias" && bodyElement.declaration.type !== "InterfaceDeclaration");
}
function hasTypeImportKind(node) {
  return node.importKind === "type" || node.importKind === "typeof";
}
const exportSuggestions = {
  const: "declare export var",
  let: "declare export var",
  type: "export type",
  interface: "export interface"
};
function partition(list, test) {
  const list1 = [], list2 = [];
  for (let i = 0; i < list.length; i++)
    (test(list[i], i, list) ? list1 : list2).push(list[i]);
  return [list1, list2];
}
const FLOW_PRAGMA_REGEX = /\*?\s*@((?:no)?flow)\b/;
var stdin_default = (superClass) => class extends superClass {
  flowPragma = void 0;
  getScopeHandler() {
    return FlowScopeHandler;
  }
  shouldParseTypes() {
    return this.getPluginOption("flow", "all") || this.flowPragma === "flow";
  }
  finishToken(type, val) {
    type !== tt.string && type !== tt.semi && type !== tt.interpreterDirective && this.flowPragma === void 0 && (this.flowPragma = null), super.finishToken(type, val);
  }
  addComment(comment) {
    if (this.flowPragma === void 0) {
      const matches = FLOW_PRAGMA_REGEX.exec(comment.value);
      if (matches)
        if (matches[1] === "flow")
          this.flowPragma = "flow";
        else if (matches[1] === "noflow")
          this.flowPragma = "noflow";
        else
          throw new Error("Unexpected flow pragma");
    }
    super.addComment(comment);
  }
  flowParseTypeInitialiser(tok) {
    const oldInType = this.state.inType;
    this.state.inType = !0, this.expect(tok || tt.colon);
    const type = this.flowParseType();
    return this.state.inType = oldInType, type;
  }
  flowParsePredicate() {
    const node = this.startNode(), moduloLoc = this.state.startLoc;
    return this.next(), this.expectContextual(tt._checks), this.state.lastTokStartLoc.index > moduloLoc.index + 1 && this.raise(FlowErrors.UnexpectedSpaceBetweenModuloChecks, moduloLoc), this.eat(tt.parenL) ? (node.value = super.parseExpression(), this.expect(tt.parenR), this.finishNode(node, "DeclaredPredicate")) : this.finishNode(node, "InferredPredicate");
  }
  flowParseTypeAndPredicateInitialiser() {
    const oldInType = this.state.inType;
    this.state.inType = !0, this.expect(tt.colon);
    let type = null, predicate = null;
    return this.match(tt.modulo) ? (this.state.inType = oldInType, predicate = this.flowParsePredicate()) : (type = this.flowParseType(), this.state.inType = oldInType, this.match(tt.modulo) && (predicate = this.flowParsePredicate())), [type, predicate];
  }
  flowParseDeclareClass(node) {
    return this.next(), this.flowParseInterfaceish(node, !0), this.finishNode(node, "DeclareClass");
  }
  flowParseDeclareFunction(node) {
    this.next();
    const id = node.id = this.parseIdentifier(), typeNode = this.startNode(), typeContainer = this.startNode();
    this.match(tt.lt) ? typeNode.typeParameters = this.flowParseTypeParameterDeclaration() : typeNode.typeParameters = null, this.expect(tt.parenL);
    const tmp = this.flowParseFunctionTypeParams();
    return typeNode.params = tmp.params, typeNode.rest = tmp.rest, typeNode.this = tmp._this, this.expect(tt.parenR), [typeNode.returnType, node.predicate] = this.flowParseTypeAndPredicateInitialiser(), typeContainer.typeAnnotation = this.finishNode(typeNode, "FunctionTypeAnnotation"), id.typeAnnotation = this.finishNode(typeContainer, "TypeAnnotation"), this.resetEndLocation(id), this.semicolon(), this.scope.declareName(node.id.name, BindingFlag.TYPE_FLOW_DECLARE_FN, node.id.loc.start), this.finishNode(node, "DeclareFunction");
  }
  flowParseDeclare(node, insideModule) {
    if (this.match(tt._class))
      return this.flowParseDeclareClass(node);
    if (this.match(tt._function))
      return this.flowParseDeclareFunction(node);
    if (this.match(tt._var))
      return this.flowParseDeclareVariable(node);
    if (this.eatContextual(tt._module))
      return this.match(tt.dot) ? this.flowParseDeclareModuleExports(node) : (insideModule && this.raise(FlowErrors.NestedDeclareModule, this.state.lastTokStartLoc), this.flowParseDeclareModule(node));
    if (this.isContextual(tt._type))
      return this.flowParseDeclareTypeAlias(node);
    if (this.isContextual(tt._opaque))
      return this.flowParseDeclareOpaqueType(node);
    if (this.isContextual(tt._interface))
      return this.flowParseDeclareInterface(node);
    if (this.match(tt._export))
      return this.flowParseDeclareExportDeclaration(node, insideModule);
    throw this.unexpected();
  }
  flowParseDeclareVariable(node) {
    return this.next(), node.id = this.flowParseTypeAnnotatableIdentifier(), this.scope.declareName(node.id.name, BindingFlag.TYPE_VAR, node.id.loc.start), this.semicolon(), this.finishNode(node, "DeclareVariable");
  }
  flowParseDeclareModule(node) {
    this.scope.enter(ScopeFlag.OTHER), this.match(tt.string) ? node.id = super.parseExprAtom() : node.id = this.parseIdentifier();
    const bodyNode = node.body = this.startNode(), body = bodyNode.body = [];
    for (this.expect(tt.braceL); !this.match(tt.braceR); ) {
      const bodyNode2 = this.startNode();
      this.match(tt._import) ? (this.next(), !this.isContextual(tt._type) && !this.match(tt._typeof) && this.raise(FlowErrors.InvalidNonTypeImportInDeclareModule, this.state.lastTokStartLoc), body.push(super.parseImport(bodyNode2))) : (this.expectContextual(tt._declare, FlowErrors.UnsupportedStatementInDeclareModule), body.push(this.flowParseDeclare(bodyNode2, !0)));
    }
    this.scope.exit(), this.expect(tt.braceR), this.finishNode(bodyNode, "BlockStatement");
    let kind = null, hasModuleExport = !1;
    return body.forEach((bodyElement) => {
      isEsModuleType(bodyElement) ? (kind === "CommonJS" && this.raise(FlowErrors.AmbiguousDeclareModuleKind, bodyElement), kind = "ES") : bodyElement.type === "DeclareModuleExports" && (hasModuleExport && this.raise(FlowErrors.DuplicateDeclareModuleExports, bodyElement), kind === "ES" && this.raise(FlowErrors.AmbiguousDeclareModuleKind, bodyElement), kind = "CommonJS", hasModuleExport = !0);
    }), node.kind = kind || "CommonJS", this.finishNode(node, "DeclareModule");
  }
  flowParseDeclareExportDeclaration(node, insideModule) {
    if (this.expect(tt._export), this.eat(tt._default))
      return this.match(tt._function) || this.match(tt._class) ? node.declaration = this.flowParseDeclare(this.startNode()) : (node.declaration = this.flowParseType(), this.semicolon()), node.default = !0, this.finishNode(node, "DeclareExportDeclaration");
    if (this.match(tt._const) || this.isLet() || (this.isContextual(tt._type) || this.isContextual(tt._interface)) && !insideModule) {
      const label = this.state.value;
      throw this.raise(FlowErrors.UnsupportedDeclareExportKind, this.state.startLoc, {
        unsupportedExportKind: label,
        suggestion: exportSuggestions[label]
      });
    }
    if (this.match(tt._var) || this.match(tt._function) || this.match(tt._class) || this.isContextual(tt._opaque))
      return node.declaration = this.flowParseDeclare(this.startNode()), node.default = !1, this.finishNode(node, "DeclareExportDeclaration");
    if (this.match(tt.star) || this.match(tt.braceL) || this.isContextual(tt._interface) || this.isContextual(tt._type) || this.isContextual(tt._opaque))
      return node = this.parseExport(node, null), node.type === "ExportNamedDeclaration" ? (node.default = !1, delete node.exportKind, this.castNodeTo(node, "DeclareExportDeclaration")) : this.castNodeTo(node, "DeclareExportAllDeclaration");
    throw this.unexpected();
  }
  flowParseDeclareModuleExports(node) {
    return this.next(), this.expectContextual(tt._exports), node.typeAnnotation = this.flowParseTypeAnnotation(), this.semicolon(), this.finishNode(node, "DeclareModuleExports");
  }
  flowParseDeclareTypeAlias(node) {
    this.next();
    const finished = this.flowParseTypeAlias(node);
    return this.castNodeTo(finished, "DeclareTypeAlias"), finished;
  }
  flowParseDeclareOpaqueType(node) {
    this.next();
    const finished = this.flowParseOpaqueType(node, !0);
    return this.castNodeTo(finished, "DeclareOpaqueType"), finished;
  }
  flowParseDeclareInterface(node) {
    return this.next(), this.flowParseInterfaceish(node, !1), this.finishNode(node, "DeclareInterface");
  }
  flowParseInterfaceish(node, isClass) {
    if (node.id = this.flowParseRestrictedIdentifier(!isClass, !0), this.scope.declareName(node.id.name, isClass ? BindingFlag.TYPE_FUNCTION : BindingFlag.TYPE_LEXICAL, node.id.loc.start), this.match(tt.lt) ? node.typeParameters = this.flowParseTypeParameterDeclaration() : node.typeParameters = null, node.extends = [], this.eat(tt._extends))
      do
        node.extends.push(this.flowParseInterfaceExtends());
      while (!isClass && this.eat(tt.comma));
    if (isClass) {
      if (node.implements = [], node.mixins = [], this.eatContextual(tt._mixins))
        do
          node.mixins.push(this.flowParseInterfaceExtends());
        while (this.eat(tt.comma));
      if (this.eatContextual(tt._implements))
        do
          node.implements.push(this.flowParseInterfaceExtends());
        while (this.eat(tt.comma));
    }
    node.body = this.flowParseObjectType({
      allowStatic: isClass,
      allowExact: !1,
      allowSpread: !1,
      allowProto: isClass,
      allowInexact: !1
    });
  }
  flowParseInterfaceExtends() {
    const node = this.startNode();
    return node.id = this.flowParseQualifiedTypeIdentifier(), this.match(tt.lt) ? node.typeParameters = this.flowParseTypeParameterInstantiation() : node.typeParameters = null, this.finishNode(node, "InterfaceExtends");
  }
  flowParseInterface(node) {
    return this.flowParseInterfaceish(node, !1), this.finishNode(node, "InterfaceDeclaration");
  }
  checkNotUnderscore(word) {
    word === "_" && this.raise(FlowErrors.UnexpectedReservedUnderscore, this.state.startLoc);
  }
  checkReservedType(word, startLoc, declaration) {
    reservedTypes.has(word) && this.raise(declaration ? FlowErrors.AssignReservedType : FlowErrors.UnexpectedReservedType, startLoc, {
      reservedType: word
    });
  }
  flowParseRestrictedIdentifierName(liberal, declaration) {
    return this.checkReservedType(this.state.value, this.state.startLoc, declaration), this.parseIdentifierName(liberal);
  }
  flowParseRestrictedIdentifier(liberal, declaration) {
    const node = this.startNode(), name = this.flowParseRestrictedIdentifierName(liberal, declaration);
    return this.createIdentifier(node, name);
  }
  flowParseTypeAlias(node) {
    return node.id = this.flowParseRestrictedIdentifier(!1, !0), this.scope.declareName(node.id.name, BindingFlag.TYPE_LEXICAL, node.id.loc.start), this.match(tt.lt) ? node.typeParameters = this.flowParseTypeParameterDeclaration() : node.typeParameters = null, node.right = this.flowParseTypeInitialiser(tt.eq), this.semicolon(), this.finishNode(node, "TypeAlias");
  }
  flowParseOpaqueType(node, declare) {
    return this.expectContextual(tt._type), node.id = this.flowParseRestrictedIdentifier(!0, !0), this.scope.declareName(node.id.name, BindingFlag.TYPE_LEXICAL, node.id.loc.start), this.match(tt.lt) ? node.typeParameters = this.flowParseTypeParameterDeclaration() : node.typeParameters = null, node.supertype = null, this.match(tt.colon) && (node.supertype = this.flowParseTypeInitialiser(tt.colon)), node.impltype = null, declare || (node.impltype = this.flowParseTypeInitialiser(tt.eq)), this.semicolon(), this.finishNode(node, "OpaqueType");
  }
  flowParseTypeParameterBound() {
    if (this.match(tt.colon) || this.isContextual(tt._extends)) {
      const node = this.startNode();
      return this.next(), node.typeAnnotation = this.flowParseType(), this.finishNode(node, "TypeAnnotation");
    }
  }
  flowParseTypeParameter(requireDefault = !1) {
    const nodeStartLoc = this.state.startLoc, node = this.startNode(), variance = this.flowParseVariance();
    return node.name = this.flowParseRestrictedIdentifierName(), node.variance = variance, node.bound = this.flowParseTypeParameterBound(), this.match(tt.eq) ? (this.eat(tt.eq), node.default = this.flowParseType()) : requireDefault && this.raise(FlowErrors.MissingTypeParamDefault, nodeStartLoc), this.finishNode(node, "TypeParameter");
  }
  flowParseTypeParameterDeclaration() {
    const oldInType = this.state.inType, node = this.startNode();
    node.params = [], this.state.inType = !0, this.match(tt.lt) || this.match(tt.jsxTagStart) ? this.next() : this.unexpected();
    let defaultRequired = !1;
    do {
      const typeParameter = this.flowParseTypeParameter(defaultRequired);
      node.params.push(typeParameter), typeParameter.default && (defaultRequired = !0), this.match(tt.gt) || this.expect(tt.comma);
    } while (!this.match(tt.gt));
    return this.expect(tt.gt), this.state.inType = oldInType, this.finishNode(node, "TypeParameterDeclaration");
  }
  flowInTopLevelContext(cb) {
    if (this.curContext() !== tc.brace) {
      const oldContext = this.state.context;
      this.state.context = [oldContext[0]];
      try {
        return cb();
      } finally {
        this.state.context = oldContext;
      }
    } else
      return cb();
  }
  flowParseTypeParameterInstantiationInExpression() {
    if (this.reScan_lt() === tt.lt)
      return this.flowParseTypeParameterInstantiation();
  }
  flowParseTypeParameterInstantiation() {
    const node = this.startNode(), oldInType = this.state.inType;
    return this.state.inType = !0, node.params = [], this.flowInTopLevelContext(() => {
      this.expect(tt.lt);
      const oldNoAnonFunctionType = this.state.noAnonFunctionType;
      for (this.state.noAnonFunctionType = !1; !this.match(tt.gt); )
        node.params.push(this.flowParseType()), this.match(tt.gt) || this.expect(tt.comma);
      this.state.noAnonFunctionType = oldNoAnonFunctionType;
    }), this.state.inType = oldInType, !this.state.inType && this.curContext() === tc.brace && this.reScan_lt_gt(), this.expect(tt.gt), this.finishNode(node, "TypeParameterInstantiation");
  }
  flowParseTypeParameterInstantiationCallOrNew() {
    if (this.reScan_lt() !== tt.lt) return null;
    const node = this.startNode(), oldInType = this.state.inType;
    for (node.params = [], this.state.inType = !0, this.expect(tt.lt); !this.match(tt.gt); )
      node.params.push(this.flowParseTypeOrImplicitInstantiation()), this.match(tt.gt) || this.expect(tt.comma);
    return this.expect(tt.gt), this.state.inType = oldInType, this.finishNode(node, "TypeParameterInstantiation");
  }
  flowParseInterfaceType() {
    const node = this.startNode();
    if (this.expectContextual(tt._interface), node.extends = [], this.eat(tt._extends))
      do
        node.extends.push(this.flowParseInterfaceExtends());
      while (this.eat(tt.comma));
    return node.body = this.flowParseObjectType({
      allowStatic: !1,
      allowExact: !1,
      allowSpread: !1,
      allowProto: !1,
      allowInexact: !1
    }), this.finishNode(node, "InterfaceTypeAnnotation");
  }
  flowParseObjectPropertyKey() {
    return this.match(tt.num) || this.match(tt.string) ? super.parseExprAtom() : this.parseIdentifier(!0);
  }
  flowParseObjectTypeIndexer(node, isStatic, variance) {
    return node.static = isStatic, this.lookahead().type === tt.colon ? (node.id = this.flowParseObjectPropertyKey(), node.key = this.flowParseTypeInitialiser()) : (node.id = null, node.key = this.flowParseType()), this.expect(tt.bracketR), node.value = this.flowParseTypeInitialiser(), node.variance = variance, this.finishNode(node, "ObjectTypeIndexer");
  }
  flowParseObjectTypeInternalSlot(node, isStatic) {
    return node.static = isStatic, node.id = this.flowParseObjectPropertyKey(), this.expect(tt.bracketR), this.expect(tt.bracketR), this.match(tt.lt) || this.match(tt.parenL) ? (node.method = !0, node.optional = !1, node.value = this.flowParseObjectTypeMethodish(this.startNodeAt(node.loc.start))) : (node.method = !1, this.eat(tt.question) && (node.optional = !0), node.value = this.flowParseTypeInitialiser()), this.finishNode(node, "ObjectTypeInternalSlot");
  }
  flowParseObjectTypeMethodish(node) {
    for (node.params = [], node.rest = null, node.typeParameters = null, node.this = null, this.match(tt.lt) && (node.typeParameters = this.flowParseTypeParameterDeclaration()), this.expect(tt.parenL), this.match(tt._this) && (node.this = this.flowParseFunctionTypeParam(!0), node.this.name = null, this.match(tt.parenR) || this.expect(tt.comma)); !this.match(tt.parenR) && !this.match(tt.ellipsis); )
      node.params.push(this.flowParseFunctionTypeParam(!1)), this.match(tt.parenR) || this.expect(tt.comma);
    return this.eat(tt.ellipsis) && (node.rest = this.flowParseFunctionTypeParam(!1)), this.expect(tt.parenR), node.returnType = this.flowParseTypeInitialiser(), this.finishNode(node, "FunctionTypeAnnotation");
  }
  flowParseObjectTypeCallProperty(node, isStatic) {
    const valueNode = this.startNode();
    return node.static = isStatic, node.value = this.flowParseObjectTypeMethodish(valueNode), this.finishNode(node, "ObjectTypeCallProperty");
  }
  flowParseObjectType({
    allowStatic,
    allowExact,
    allowSpread,
    allowProto,
    allowInexact
  }) {
    const oldInType = this.state.inType;
    this.state.inType = !0;
    const nodeStart = this.startNode();
    nodeStart.callProperties = [], nodeStart.properties = [], nodeStart.indexers = [], nodeStart.internalSlots = [];
    let endDelim, exact, inexact = !1;
    for (allowExact && this.match(tt.braceBarL) ? (this.expect(tt.braceBarL), endDelim = tt.braceBarR, exact = !0) : (this.expect(tt.braceL), endDelim = tt.braceR, exact = !1), nodeStart.exact = exact; !this.match(endDelim); ) {
      let isStatic = !1, protoStartLoc = null, inexactStartLoc = null;
      const node = this.startNode();
      if (allowProto && this.isContextual(tt._proto)) {
        const lookahead = this.lookahead();
        lookahead.type !== tt.colon && lookahead.type !== tt.question && (this.next(), protoStartLoc = this.state.startLoc, allowStatic = !1);
      }
      if (allowStatic && this.isContextual(tt._static)) {
        const lookahead = this.lookahead();
        lookahead.type !== tt.colon && lookahead.type !== tt.question && (this.next(), isStatic = !0);
      }
      const variance = this.flowParseVariance();
      if (this.eat(tt.bracketL))
        protoStartLoc != null && this.unexpected(protoStartLoc), this.eat(tt.bracketL) ? (variance && this.unexpected(variance.loc.start), nodeStart.internalSlots.push(this.flowParseObjectTypeInternalSlot(node, isStatic))) : nodeStart.indexers.push(this.flowParseObjectTypeIndexer(node, isStatic, variance));
      else if (this.match(tt.parenL) || this.match(tt.lt))
        protoStartLoc != null && this.unexpected(protoStartLoc), variance && this.unexpected(variance.loc.start), nodeStart.callProperties.push(this.flowParseObjectTypeCallProperty(node, isStatic));
      else {
        let kind = "init";
        if (this.isContextual(tt._get) || this.isContextual(tt._set)) {
          const lookahead = this.lookahead();
          tokenIsLiteralPropertyName(lookahead.type) && (kind = this.state.value, this.next());
        }
        const propOrInexact = this.flowParseObjectTypeProperty(node, isStatic, protoStartLoc, variance, kind, allowSpread, allowInexact ?? !exact);
        propOrInexact === null ? (inexact = !0, inexactStartLoc = this.state.lastTokStartLoc) : nodeStart.properties.push(propOrInexact);
      }
      this.flowObjectTypeSemicolon(), inexactStartLoc && !this.match(tt.braceR) && !this.match(tt.braceBarR) && this.raise(FlowErrors.UnexpectedExplicitInexactInObject, inexactStartLoc);
    }
    this.expect(endDelim), allowSpread && (nodeStart.inexact = inexact);
    const out = this.finishNode(nodeStart, "ObjectTypeAnnotation");
    return this.state.inType = oldInType, out;
  }
  flowParseObjectTypeProperty(node, isStatic, protoStartLoc, variance, kind, allowSpread, allowInexact) {
    if (this.eat(tt.ellipsis))
      return this.match(tt.comma) || this.match(tt.semi) || this.match(tt.braceR) || this.match(tt.braceBarR) ? (allowSpread ? allowInexact || this.raise(FlowErrors.InexactInsideExact, this.state.lastTokStartLoc) : this.raise(FlowErrors.InexactInsideNonObject, this.state.lastTokStartLoc), variance && this.raise(FlowErrors.InexactVariance, variance), null) : (allowSpread || this.raise(FlowErrors.UnexpectedSpreadType, this.state.lastTokStartLoc), protoStartLoc != null && this.unexpected(protoStartLoc), variance && this.raise(FlowErrors.SpreadVariance, variance), node.argument = this.flowParseType(), this.finishNode(node, "ObjectTypeSpreadProperty"));
    {
      node.key = this.flowParseObjectPropertyKey(), node.static = isStatic, node.proto = protoStartLoc != null, node.kind = kind;
      let optional = !1;
      return this.match(tt.lt) || this.match(tt.parenL) ? (node.method = !0, protoStartLoc != null && this.unexpected(protoStartLoc), variance && this.unexpected(variance.loc.start), node.value = this.flowParseObjectTypeMethodish(this.startNodeAt(node.loc.start)), (kind === "get" || kind === "set") && this.flowCheckGetterSetterParams(node), !allowSpread && node.key.name === "constructor" && node.value.this && this.raise(FlowErrors.ThisParamBannedInConstructor, node.value.this)) : (kind !== "init" && this.unexpected(), node.method = !1, this.eat(tt.question) && (optional = !0), node.value = this.flowParseTypeInitialiser(), node.variance = variance), node.optional = optional, this.finishNode(node, "ObjectTypeProperty");
    }
  }
  flowCheckGetterSetterParams(property) {
    const paramCount = property.kind === "get" ? 0 : 1, length = property.value.params.length + (property.value.rest ? 1 : 0);
    property.value.this && this.raise(property.kind === "get" ? FlowErrors.GetterMayNotHaveThisParam : FlowErrors.SetterMayNotHaveThisParam, property.value.this), length !== paramCount && this.raise(property.kind === "get" ? Errors.BadGetterArity : Errors.BadSetterArity, property), property.kind === "set" && property.value.rest && this.raise(Errors.BadSetterRestParameter, property);
  }
  flowObjectTypeSemicolon() {
    !this.eat(tt.semi) && !this.eat(tt.comma) && !this.match(tt.braceR) && !this.match(tt.braceBarR) && this.unexpected();
  }
  flowParseQualifiedTypeIdentifier(startLoc, id) {
    startLoc ??= this.state.startLoc;
    let node = id || this.flowParseRestrictedIdentifier(!0);
    for (; this.eat(tt.dot); ) {
      const node2 = this.startNodeAt(startLoc);
      node2.qualification = node, node2.id = this.flowParseRestrictedIdentifier(!0), node = this.finishNode(node2, "QualifiedTypeIdentifier");
    }
    return node;
  }
  flowParseGenericType(startLoc, id) {
    const node = this.startNodeAt(startLoc);
    return node.typeParameters = null, node.id = this.flowParseQualifiedTypeIdentifier(startLoc, id), this.match(tt.lt) && (node.typeParameters = this.flowParseTypeParameterInstantiation()), this.finishNode(node, "GenericTypeAnnotation");
  }
  flowParseTypeofType() {
    const node = this.startNode();
    return this.expect(tt._typeof), node.argument = this.flowParsePrimaryType(), this.finishNode(node, "TypeofTypeAnnotation");
  }
  flowParseTupleType() {
    const node = this.startNode();
    for (node.types = [], this.expect(tt.bracketL); this.state.pos < this.length && !this.match(tt.bracketR) && (node.types.push(this.flowParseType()), !this.match(tt.bracketR)); )
      this.expect(tt.comma);
    return this.expect(tt.bracketR), this.finishNode(node, "TupleTypeAnnotation");
  }
  flowParseFunctionTypeParam(first) {
    let name = null, optional = !1, typeAnnotation = null;
    const node = this.startNode(), lh = this.lookahead(), isThis = this.state.type === tt._this;
    return lh.type === tt.colon || lh.type === tt.question ? (isThis && !first && this.raise(FlowErrors.ThisParamMustBeFirst, node), name = this.parseIdentifier(isThis), this.eat(tt.question) && (optional = !0, isThis && this.raise(FlowErrors.ThisParamMayNotBeOptional, node)), typeAnnotation = this.flowParseTypeInitialiser()) : typeAnnotation = this.flowParseType(), node.name = name, node.optional = optional, node.typeAnnotation = typeAnnotation, this.finishNode(node, "FunctionTypeParam");
  }
  reinterpretTypeAsFunctionTypeParam(type) {
    const node = this.startNodeAt(type.loc.start);
    return node.name = null, node.optional = !1, node.typeAnnotation = type, this.finishNode(node, "FunctionTypeParam");
  }
  flowParseFunctionTypeParams(params = []) {
    let rest = null, _this = null;
    for (this.match(tt._this) && (_this = this.flowParseFunctionTypeParam(!0), _this.name = null, this.match(tt.parenR) || this.expect(tt.comma)); !this.match(tt.parenR) && !this.match(tt.ellipsis); )
      params.push(this.flowParseFunctionTypeParam(!1)), this.match(tt.parenR) || this.expect(tt.comma);
    return this.eat(tt.ellipsis) && (rest = this.flowParseFunctionTypeParam(!1)), {
      params,
      rest,
      _this
    };
  }
  flowIdentToTypeAnnotation(startLoc, node, id) {
    switch (id.name) {
      case "any":
        return this.finishNode(node, "AnyTypeAnnotation");
      case "bool":
      case "boolean":
        return this.finishNode(node, "BooleanTypeAnnotation");
      case "mixed":
        return this.finishNode(node, "MixedTypeAnnotation");
      case "empty":
        return this.finishNode(node, "EmptyTypeAnnotation");
      case "number":
        return this.finishNode(node, "NumberTypeAnnotation");
      case "string":
        return this.finishNode(node, "StringTypeAnnotation");
      case "symbol":
        return this.finishNode(node, "SymbolTypeAnnotation");
      default:
        return this.checkNotUnderscore(id.name), this.flowParseGenericType(startLoc, id);
    }
  }
  flowParsePrimaryType() {
    const startLoc = this.state.startLoc, node = this.startNode();
    let tmp, type, isGroupedType = !1;
    const oldNoAnonFunctionType = this.state.noAnonFunctionType;
    switch (this.state.type) {
      case tt.braceL:
        return this.flowParseObjectType({
          allowStatic: !1,
          allowExact: !1,
          allowSpread: !0,
          allowProto: !1,
          allowInexact: !0
        });
      case tt.braceBarL:
        return this.flowParseObjectType({
          allowStatic: !1,
          allowExact: !0,
          allowSpread: !0,
          allowProto: !1,
          allowInexact: !1
        });
      case tt.bracketL:
        return this.state.noAnonFunctionType = !1, type = this.flowParseTupleType(), this.state.noAnonFunctionType = oldNoAnonFunctionType, type;
      case tt.lt: {
        const node2 = this.startNode();
        return node2.typeParameters = this.flowParseTypeParameterDeclaration(), this.expect(tt.parenL), tmp = this.flowParseFunctionTypeParams(), node2.params = tmp.params, node2.rest = tmp.rest, node2.this = tmp._this, this.expect(tt.parenR), this.expect(tt.arrow), node2.returnType = this.flowParseType(), this.finishNode(node2, "FunctionTypeAnnotation");
      }
      case tt.parenL: {
        const node2 = this.startNode();
        if (this.next(), !this.match(tt.parenR) && !this.match(tt.ellipsis))
          if (tokenIsIdentifier(this.state.type) || this.match(tt._this)) {
            const token = this.lookahead().type;
            isGroupedType = token !== tt.question && token !== tt.colon;
          } else
            isGroupedType = !0;
        if (isGroupedType) {
          if (this.state.noAnonFunctionType = !1, type = this.flowParseType(), this.state.noAnonFunctionType = oldNoAnonFunctionType, this.state.noAnonFunctionType || !(this.match(tt.comma) || this.match(tt.parenR) && this.lookahead().type === tt.arrow))
            return this.expect(tt.parenR), type;
          this.eat(tt.comma);
        }
        return type ? tmp = this.flowParseFunctionTypeParams([this.reinterpretTypeAsFunctionTypeParam(type)]) : tmp = this.flowParseFunctionTypeParams(), node2.params = tmp.params, node2.rest = tmp.rest, node2.this = tmp._this, this.expect(tt.parenR), this.expect(tt.arrow), node2.returnType = this.flowParseType(), node2.typeParameters = null, this.finishNode(node2, "FunctionTypeAnnotation");
      }
      case tt.string:
        return this.parseLiteral(this.state.value, "StringLiteralTypeAnnotation");
      case tt._true:
      case tt._false:
        return node.value = this.match(tt._true), this.next(), this.finishNode(node, "BooleanLiteralTypeAnnotation");
      case tt.plusMin:
        if (this.state.value === "-") {
          if (this.next(), this.match(tt.num))
            return this.parseLiteralAtNode(-this.state.value, "NumberLiteralTypeAnnotation", node);
          if (this.match(tt.bigint))
            return this.parseLiteralAtNode(-this.state.value, "BigIntLiteralTypeAnnotation", node);
          throw this.raise(FlowErrors.UnexpectedSubtractionOperand, this.state.startLoc);
        }
        throw this.unexpected();
      case tt.num:
        return this.parseLiteral(this.state.value, "NumberLiteralTypeAnnotation");
      case tt.bigint:
        return this.parseLiteral(this.state.value, "BigIntLiteralTypeAnnotation");
      case tt._void:
        return this.next(), this.finishNode(node, "VoidTypeAnnotation");
      case tt._null:
        return this.next(), this.finishNode(node, "NullLiteralTypeAnnotation");
      case tt._this:
        return this.next(), this.finishNode(node, "ThisTypeAnnotation");
      case tt.star:
        return this.next(), this.finishNode(node, "ExistsTypeAnnotation");
      case tt._typeof:
        return this.flowParseTypeofType();
      default:
        if (tokenIsKeyword(this.state.type)) {
          const label = tokenLabelName(this.state.type);
          return this.next(), super.createIdentifier(node, label);
        } else if (tokenIsIdentifier(this.state.type))
          return this.isContextual(tt._interface) ? this.flowParseInterfaceType() : this.flowIdentToTypeAnnotation(startLoc, node, this.parseIdentifier());
    }
    throw this.unexpected();
  }
  flowParsePostfixType() {
    const startLoc = this.state.startLoc;
    let type = this.flowParsePrimaryType(), seenOptionalIndexedAccess = !1;
    for (; (this.match(tt.bracketL) || this.match(tt.questionDot)) && !this.canInsertSemicolon(); ) {
      const node = this.startNodeAt(startLoc), optional = this.eat(tt.questionDot);
      seenOptionalIndexedAccess = seenOptionalIndexedAccess || optional, this.expect(tt.bracketL), !optional && this.match(tt.bracketR) ? (node.elementType = type, this.next(), type = this.finishNode(node, "ArrayTypeAnnotation")) : (node.objectType = type, node.indexType = this.flowParseType(), this.expect(tt.bracketR), seenOptionalIndexedAccess ? (node.optional = optional, type = this.finishNode(node, "OptionalIndexedAccessType")) : type = this.finishNode(node, "IndexedAccessType"));
    }
    return type;
  }
  flowParsePrefixType() {
    const node = this.startNode();
    return this.eat(tt.question) ? (node.typeAnnotation = this.flowParsePrefixType(), this.finishNode(node, "NullableTypeAnnotation")) : this.flowParsePostfixType();
  }
  flowParseAnonFunctionWithoutParens() {
    const param = this.flowParsePrefixType();
    if (!this.state.noAnonFunctionType && this.eat(tt.arrow)) {
      const node = this.startNodeAt(param.loc.start);
      return node.params = [this.reinterpretTypeAsFunctionTypeParam(param)], node.rest = null, node.this = null, node.returnType = this.flowParseType(), node.typeParameters = null, this.finishNode(node, "FunctionTypeAnnotation");
    }
    return param;
  }
  flowParseIntersectionType() {
    const node = this.startNode();
    this.eat(tt.bitwiseAND);
    const type = this.flowParseAnonFunctionWithoutParens();
    for (node.types = [type]; this.eat(tt.bitwiseAND); )
      node.types.push(this.flowParseAnonFunctionWithoutParens());
    return node.types.length === 1 ? type : this.finishNode(node, "IntersectionTypeAnnotation");
  }
  flowParseUnionType() {
    const node = this.startNode();
    this.eat(tt.bitwiseOR);
    const type = this.flowParseIntersectionType();
    for (node.types = [type]; this.eat(tt.bitwiseOR); )
      node.types.push(this.flowParseIntersectionType());
    return node.types.length === 1 ? type : this.finishNode(node, "UnionTypeAnnotation");
  }
  flowParseType() {
    const oldInType = this.state.inType;
    this.state.inType = !0;
    const type = this.flowParseUnionType();
    return this.state.inType = oldInType, type;
  }
  flowParseTypeOrImplicitInstantiation() {
    if (this.state.type === tt.name && this.state.value === "_") {
      const startLoc = this.state.startLoc, node = this.parseIdentifier();
      return this.flowParseGenericType(startLoc, node);
    } else
      return this.flowParseType();
  }
  flowParseTypeAnnotation() {
    const node = this.startNode();
    return node.typeAnnotation = this.flowParseTypeInitialiser(), this.finishNode(node, "TypeAnnotation");
  }
  flowParseTypeAnnotatableIdentifier() {
    const node = this.startNode(), name = this.parseIdentifierName();
    return this.match(tt.colon) && (node.typeAnnotation = this.flowParseTypeAnnotation()), this.createIdentifier(node, name);
  }
  typeCastToParameter(node) {
    return node.expression.typeAnnotation = node.typeAnnotation, this.resetEndLocation(node.expression, node.typeAnnotation.loc.end), node.expression;
  }
  flowParseVariance() {
    let variance = null;
    return this.match(tt.plusMin) ? (variance = this.startNode(), this.state.value === "+" ? variance.kind = "plus" : variance.kind = "minus", this.next(), this.finishNode(variance, "Variance")) : variance;
  }
  parseFunctionBody(node, allowExpressionBody, isMethod = !1) {
    if (allowExpressionBody) {
      this.forwardNoArrowParamsConversionAt(node, () => super.parseFunctionBody(node, !0, isMethod));
      return;
    }
    super.parseFunctionBody(node, !1, isMethod);
  }
  parseFunctionBodyAndFinish(node, type, isMethod = !1) {
    if (this.match(tt.colon)) {
      const typeNode = this.startNode();
      [typeNode.typeAnnotation, node.predicate] = this.flowParseTypeAndPredicateInitialiser(), node.returnType = typeNode.typeAnnotation ? this.finishNode(typeNode, "TypeAnnotation") : null;
    }
    return super.parseFunctionBodyAndFinish(node, type, isMethod);
  }
  parseStatementLike(flags) {
    if (this.state.strict && this.isContextual(tt._interface)) {
      const lookahead = this.lookahead();
      if (tokenIsKeywordOrIdentifier(lookahead.type)) {
        const node = this.startNode();
        return this.next(), this.flowParseInterface(node);
      }
    } else if (this.isContextual(tt._enum)) {
      const node = this.startNode();
      return this.next(), this.flowParseEnumDeclaration(node);
    }
    const stmt = super.parseStatementLike(flags);
    return this.flowPragma === void 0 && !this.isValidDirective(stmt) && (this.flowPragma = null), stmt;
  }
  parseExpressionStatement(node, expr, decorators) {
    if (expr.type === "Identifier") {
      if (expr.name === "declare") {
        if (this.match(tt._class) || tokenIsIdentifier(this.state.type) || this.match(tt._function) || this.match(tt._var) || this.match(tt._export))
          return this.flowParseDeclare(node);
      } else if (tokenIsIdentifier(this.state.type)) {
        if (expr.name === "interface")
          return this.flowParseInterface(node);
        if (expr.name === "type")
          return this.flowParseTypeAlias(node);
        if (expr.name === "opaque")
          return this.flowParseOpaqueType(node, !1);
      }
    }
    return super.parseExpressionStatement(node, expr, decorators);
  }
  shouldParseExportDeclaration() {
    const {
      type
    } = this.state;
    return type === tt._enum || tokenIsFlowInterfaceOrTypeOrOpaque(type) ? !this.state.containsEsc : super.shouldParseExportDeclaration();
  }
  isExportDefaultSpecifier() {
    const {
      type
    } = this.state;
    return type === tt._enum || tokenIsFlowInterfaceOrTypeOrOpaque(type) ? this.state.containsEsc : super.isExportDefaultSpecifier();
  }
  parseExportDefaultExpression() {
    if (this.isContextual(tt._enum)) {
      const node = this.startNode();
      return this.next(), this.flowParseEnumDeclaration(node);
    }
    return super.parseExportDefaultExpression();
  }
  parseConditional(expr, startLoc, refExpressionErrors) {
    if (!this.match(tt.question)) return expr;
    if (this.state.maybeInArrowParameters) {
      const nextCh = this.lookaheadCharCode();
      if (nextCh === 44 || nextCh === 61 || nextCh === 58 || nextCh === 41)
        return this.setOptionalParametersError(refExpressionErrors), expr;
    }
    this.expect(tt.question);
    const state = this.state.clone(), originalNoArrowAt = this.state.noArrowAt, node = this.startNodeAt(startLoc);
    let {
      consequent,
      failed
    } = this.tryParseConditionalConsequent(), [valid, invalid] = this.getArrowLikeExpressions(consequent);
    if (failed || invalid.length > 0) {
      const noArrowAt = [...originalNoArrowAt];
      if (invalid.length > 0) {
        this.state = state, this.state.noArrowAt = noArrowAt;
        for (let i = 0; i < invalid.length; i++)
          noArrowAt.push(invalid[i].start);
        ({
          consequent,
          failed
        } = this.tryParseConditionalConsequent()), [valid, invalid] = this.getArrowLikeExpressions(consequent);
      }
      failed && valid.length > 1 && this.raise(FlowErrors.AmbiguousConditionalArrow, state.startLoc), failed && valid.length === 1 && (this.state = state, noArrowAt.push(valid[0].start), this.state.noArrowAt = noArrowAt, {
        consequent,
        failed
      } = this.tryParseConditionalConsequent());
    }
    return this.getArrowLikeExpressions(consequent, !0), this.state.noArrowAt = originalNoArrowAt, this.expect(tt.colon), node.test = expr, node.consequent = consequent, node.alternate = this.forwardNoArrowParamsConversionAt(node, () => this.parseMaybeAssign(void 0, void 0)), this.finishNode(node, "ConditionalExpression");
  }
  tryParseConditionalConsequent() {
    this.state.noArrowParamsConversionAt.push(this.state.start);
    const consequent = this.parseMaybeAssignAllowIn(), failed = !this.match(tt.colon);
    return this.state.noArrowParamsConversionAt.pop(), {
      consequent,
      failed
    };
  }
  getArrowLikeExpressions(node, disallowInvalid) {
    const stack = [node], arrows = [];
    for (; stack.length !== 0; ) {
      const node2 = stack.pop();
      node2.type === "ArrowFunctionExpression" && node2.body.type !== "BlockStatement" ? (node2.typeParameters || !node2.returnType ? this.finishArrowValidation(node2) : arrows.push(node2), stack.push(node2.body)) : node2.type === "ConditionalExpression" && (stack.push(node2.consequent), stack.push(node2.alternate));
    }
    return disallowInvalid ? (arrows.forEach((node2) => this.finishArrowValidation(node2)), [arrows, []]) : partition(arrows, (node2) => node2.params.every((param) => this.isAssignable(param, !0)));
  }
  finishArrowValidation(node) {
    this.toAssignableList(node.params, node.extra?.trailingCommaLoc, !1), this.scope.enter(ScopeFlag.FUNCTION | ScopeFlag.ARROW), super.checkParams(node, !1, !0), this.scope.exit();
  }
  forwardNoArrowParamsConversionAt(node, parse) {
    let result;
    return this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start)) ? (this.state.noArrowParamsConversionAt.push(this.state.start), result = parse(), this.state.noArrowParamsConversionAt.pop()) : result = parse(), result;
  }
  parseParenItem(node, startLoc) {
    const newNode = super.parseParenItem(node, startLoc);
    if (this.eat(tt.question) && (newNode.optional = !0, this.resetEndLocation(node)), this.match(tt.colon)) {
      const typeCastNode = this.startNodeAt(startLoc);
      return typeCastNode.expression = newNode, typeCastNode.typeAnnotation = this.flowParseTypeAnnotation(), this.finishNode(typeCastNode, "TypeCastExpression");
    }
    return newNode;
  }
  assertModuleNodeAllowed(node) {
    node.type === "ImportDeclaration" && (node.importKind === "type" || node.importKind === "typeof") || node.type === "ExportNamedDeclaration" && node.exportKind === "type" || node.type === "ExportAllDeclaration" && node.exportKind === "type" || super.assertModuleNodeAllowed(node);
  }
  parseExportDeclaration(node) {
    if (this.isContextual(tt._type)) {
      node.exportKind = "type";
      const declarationNode = this.startNode();
      return this.next(), this.match(tt.braceL) ? (node.specifiers = this.parseExportSpecifiers(!0), super.parseExportFrom(node), null) : this.flowParseTypeAlias(declarationNode);
    } else if (this.isContextual(tt._opaque)) {
      node.exportKind = "type";
      const declarationNode = this.startNode();
      return this.next(), this.flowParseOpaqueType(declarationNode, !1);
    } else if (this.isContextual(tt._interface)) {
      node.exportKind = "type";
      const declarationNode = this.startNode();
      return this.next(), this.flowParseInterface(declarationNode);
    } else if (this.isContextual(tt._enum)) {
      node.exportKind = "value";
      const declarationNode = this.startNode();
      return this.next(), this.flowParseEnumDeclaration(declarationNode);
    } else
      return super.parseExportDeclaration(node);
  }
  eatExportStar(node) {
    return super.eatExportStar(node) ? !0 : this.isContextual(tt._type) && this.lookahead().type === tt.star ? (node.exportKind = "type", this.next(), this.next(), !0) : !1;
  }
  maybeParseExportNamespaceSpecifier(node) {
    const {
      startLoc
    } = this.state, hasNamespace = super.maybeParseExportNamespaceSpecifier(node);
    return hasNamespace && node.exportKind === "type" && this.unexpected(startLoc), hasNamespace;
  }
  parseClassId(node, isStatement, optionalId) {
    super.parseClassId(node, isStatement, optionalId), this.match(tt.lt) && (node.typeParameters = this.flowParseTypeParameterDeclaration());
  }
  parseClassMember(classBody, member, state) {
    const {
      startLoc
    } = this.state;
    if (this.isContextual(tt._declare)) {
      if (super.parseClassMemberFromModifier(classBody, member))
        return;
      member.declare = !0;
    }
    super.parseClassMember(classBody, member, state), member.declare && (member.type !== "ClassProperty" && member.type !== "ClassPrivateProperty" && member.type !== "PropertyDefinition" ? this.raise(FlowErrors.DeclareClassElement, startLoc) : member.value && this.raise(FlowErrors.DeclareClassFieldInitializer, member.value));
  }
  isIterator(word) {
    return word === "iterator" || word === "asyncIterator";
  }
  readIterator() {
    const word = super.readWord1(), fullWord = "@@" + word;
    (!this.isIterator(word) || !this.state.inType) && this.raise(Errors.InvalidIdentifier, this.state.curPosition(), {
      identifierName: fullWord
    }), this.finishToken(tt.name, fullWord);
  }
  getTokenFromCode(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    code === 123 && next === 124 ? this.finishOp(tt.braceBarL, 2) : this.state.inType && (code === 62 || code === 60) ? this.finishOp(code === 62 ? tt.gt : tt.lt, 1) : this.state.inType && code === 63 ? next === 46 ? this.finishOp(tt.questionDot, 2) : this.finishOp(tt.question, 1) : isIteratorStart(code, next, this.input.charCodeAt(this.state.pos + 2)) ? (this.state.pos += 2, this.readIterator()) : super.getTokenFromCode(code);
  }
  isAssignable(node, isBinding) {
    return node.type === "TypeCastExpression" ? this.isAssignable(node.expression, isBinding) : super.isAssignable(node, isBinding);
  }
  toAssignable(node, isLHS = !1) {
    !isLHS && node.type === "AssignmentExpression" && node.left.type === "TypeCastExpression" && (node.left = this.typeCastToParameter(node.left)), super.toAssignable(node, isLHS);
  }
  toAssignableList(exprList, trailingCommaLoc, isLHS) {
    for (let i = 0; i < exprList.length; i++) {
      const expr = exprList[i];
      expr?.type === "TypeCastExpression" && (exprList[i] = this.typeCastToParameter(expr));
    }
    super.toAssignableList(exprList, trailingCommaLoc, isLHS);
  }
  toReferencedList(exprList, isParenthesizedExpr) {
    for (let i = 0; i < exprList.length; i++) {
      const expr = exprList[i];
      expr && expr.type === "TypeCastExpression" && !expr.extra?.parenthesized && (exprList.length > 1 || !isParenthesizedExpr) && this.raise(FlowErrors.TypeCastInPattern, expr.typeAnnotation);
    }
    return exprList;
  }
  parseArrayLike(close, isTuple, refExpressionErrors) {
    const node = super.parseArrayLike(close, isTuple, refExpressionErrors);
    return refExpressionErrors != null && !this.state.maybeInArrowParameters && this.toReferencedList(node.elements), node;
  }
  isValidLVal(type, disallowCallExpression, isParenthesized, binding) {
    return type === "TypeCastExpression" || super.isValidLVal(type, disallowCallExpression, isParenthesized, binding);
  }
  parseClassProperty(node) {
    return this.match(tt.colon) && (node.typeAnnotation = this.flowParseTypeAnnotation()), super.parseClassProperty(node);
  }
  parseClassPrivateProperty(node) {
    return this.match(tt.colon) && (node.typeAnnotation = this.flowParseTypeAnnotation()), super.parseClassPrivateProperty(node);
  }
  isClassMethod() {
    return this.match(tt.lt) || super.isClassMethod();
  }
  isClassProperty() {
    return this.match(tt.colon) || super.isClassProperty();
  }
  isNonstaticConstructor(method) {
    return !this.match(tt.colon) && super.isNonstaticConstructor(method);
  }
  pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
    if (method.variance && this.unexpected(method.variance.loc.start), delete method.variance, this.match(tt.lt) && (method.typeParameters = this.flowParseTypeParameterDeclaration()), super.pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper), method.params && isConstructor) {
      const params = method.params;
      params.length > 0 && this.isThisParam(params[0]) && this.raise(FlowErrors.ThisParamBannedInConstructor, method);
    } else if (method.type === "MethodDefinition" && isConstructor && method.value.params) {
      const params = method.value.params;
      params.length > 0 && this.isThisParam(params[0]) && this.raise(FlowErrors.ThisParamBannedInConstructor, method);
    }
  }
  pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
    method.variance && this.unexpected(method.variance.loc.start), delete method.variance, this.match(tt.lt) && (method.typeParameters = this.flowParseTypeParameterDeclaration()), super.pushClassPrivateMethod(classBody, method, isGenerator, isAsync);
  }
  parseClassSuper(node) {
    if (super.parseClassSuper(node), node.superClass && (this.match(tt.lt) || this.match(tt.bitShiftL)) && (node.superTypeParameters = this.flowParseTypeParameterInstantiationInExpression()), this.isContextual(tt._implements)) {
      this.next();
      const implemented = node.implements = [];
      do {
        const node2 = this.startNode();
        node2.id = this.flowParseRestrictedIdentifier(!0), this.match(tt.lt) ? node2.typeParameters = this.flowParseTypeParameterInstantiation() : node2.typeParameters = null, implemented.push(this.finishNode(node2, "ClassImplements"));
      } while (this.eat(tt.comma));
    }
  }
  checkGetterSetterParams(method) {
    super.checkGetterSetterParams(method);
    const params = this.getObjectOrClassMethodParams(method);
    if (params.length > 0) {
      const param = params[0];
      this.isThisParam(param) && method.kind === "get" ? this.raise(FlowErrors.GetterMayNotHaveThisParam, param) : this.isThisParam(param) && this.raise(FlowErrors.SetterMayNotHaveThisParam, param);
    }
  }
  parsePropertyNamePrefixOperator(node) {
    node.variance = this.flowParseVariance();
  }
  parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
    prop.variance && this.unexpected(prop.variance.loc.start), delete prop.variance;
    let typeParameters;
    this.match(tt.lt) && !isAccessor && (typeParameters = this.flowParseTypeParameterDeclaration(), this.match(tt.parenL) || this.unexpected());
    const result = super.parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors);
    return typeParameters && ((result.value || result).typeParameters = typeParameters), result;
  }
  parseFunctionParamType(param) {
    return this.eat(tt.question) && (param.type !== "Identifier" && this.raise(FlowErrors.PatternIsOptional, param), this.isThisParam(param) && this.raise(FlowErrors.ThisParamMayNotBeOptional, param), param.optional = !0), this.match(tt.colon) ? param.typeAnnotation = this.flowParseTypeAnnotation() : this.isThisParam(param) && this.raise(FlowErrors.ThisParamAnnotationRequired, param), this.match(tt.eq) && this.isThisParam(param) && this.raise(FlowErrors.ThisParamNoDefault, param), this.resetEndLocation(param), param;
  }
  parseMaybeDefault(startLoc, left) {
    const node = super.parseMaybeDefault(startLoc, left);
    return node.type === "AssignmentPattern" && node.typeAnnotation && node.right.start < node.typeAnnotation.start && this.raise(FlowErrors.TypeBeforeInitializer, node.typeAnnotation), node;
  }
  checkImportReflection(node) {
    super.checkImportReflection(node), node.module && node.importKind !== "value" && this.raise(FlowErrors.ImportReflectionHasImportType, node.specifiers[0].loc.start);
  }
  parseImportSpecifierLocal(node, specifier, type) {
    specifier.local = hasTypeImportKind(node) ? this.flowParseRestrictedIdentifier(!0, !0) : this.parseIdentifier(), node.specifiers.push(this.finishImportSpecifier(specifier, type));
  }
  isPotentialImportPhase(isExport) {
    if (super.isPotentialImportPhase(isExport)) return !0;
    if (this.isContextual(tt._type)) {
      if (!isExport) return !0;
      const ch = this.lookaheadCharCode();
      return ch === 123 || ch === 42;
    }
    return !isExport && this.isContextual(tt._typeof);
  }
  applyImportPhase(node, isExport, phase, loc) {
    if (super.applyImportPhase(node, isExport, phase, loc), isExport) {
      if (!phase && this.match(tt._default))
        return;
      node.exportKind = phase === "type" ? phase : "value";
    } else
      phase === "type" && this.match(tt.star) && this.unexpected(), node.importKind = phase === "type" || phase === "typeof" ? phase : "value";
  }
  parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
    const firstIdent = specifier.imported;
    let specifierTypeKind = null;
    firstIdent.type === "Identifier" && (firstIdent.name === "type" ? specifierTypeKind = "type" : firstIdent.name === "typeof" && (specifierTypeKind = "typeof"));
    let isBinding = !1;
    if (this.isContextual(tt._as) && !this.isLookaheadContextual("as")) {
      const as_ident = this.parseIdentifier(!0);
      specifierTypeKind !== null && !tokenIsKeywordOrIdentifier(this.state.type) ? (specifier.imported = as_ident, specifier.importKind = specifierTypeKind, specifier.local = this.cloneIdentifier(as_ident)) : (specifier.imported = firstIdent, specifier.importKind = null, specifier.local = this.parseIdentifier());
    } else {
      if (specifierTypeKind !== null && tokenIsKeywordOrIdentifier(this.state.type))
        specifier.imported = this.parseIdentifier(!0), specifier.importKind = specifierTypeKind;
      else {
        if (importedIsString)
          throw this.raise(Errors.ImportBindingIsString, specifier, {
            importName: firstIdent.value
          });
        specifier.imported = firstIdent, specifier.importKind = null;
      }
      this.eatContextual(tt._as) ? specifier.local = this.parseIdentifier() : (isBinding = !0, specifier.local = this.cloneIdentifier(specifier.imported));
    }
    const specifierIsTypeImport = hasTypeImportKind(specifier);
    return isInTypeOnlyImport && specifierIsTypeImport && this.raise(FlowErrors.ImportTypeShorthandOnlyInPureImport, specifier), (isInTypeOnlyImport || specifierIsTypeImport) && this.checkReservedType(specifier.local.name, specifier.local.loc.start, !0), isBinding && !isInTypeOnlyImport && !specifierIsTypeImport && this.checkReservedWord(specifier.local.name, specifier.loc.start, !0, !0), this.finishImportSpecifier(specifier, "ImportSpecifier");
  }
  parseBindingAtom() {
    return this.state.type === tt._this ? this.parseIdentifier(!0) : super.parseBindingAtom();
  }
  parseFunctionParams(node, isConstructor) {
    const kind = node.kind;
    kind !== "get" && kind !== "set" && this.match(tt.lt) && (node.typeParameters = this.flowParseTypeParameterDeclaration()), super.parseFunctionParams(node, isConstructor);
  }
  parseVarId(decl, kind) {
    super.parseVarId(decl, kind), this.match(tt.colon) && (decl.id.typeAnnotation = this.flowParseTypeAnnotation(), this.resetEndLocation(decl.id));
  }
  parseAsyncArrowFromCallExpression(node, call) {
    if (this.match(tt.colon)) {
      const oldNoAnonFunctionType = this.state.noAnonFunctionType;
      this.state.noAnonFunctionType = !0, node.returnType = this.flowParseTypeAnnotation(), this.state.noAnonFunctionType = oldNoAnonFunctionType;
    }
    return super.parseAsyncArrowFromCallExpression(node, call);
  }
  shouldParseAsyncArrow() {
    return this.match(tt.colon) || super.shouldParseAsyncArrow();
  }
  parseMaybeAssign(refExpressionErrors, afterLeftParse) {
    let state = null, jsx;
    if (this.hasPlugin("jsx") && (this.match(tt.jsxTagStart) || this.match(tt.lt))) {
      if (state = this.state.clone(), jsx = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state), !jsx.error) return jsx.node;
      const {
        context
      } = this.state, currentContext = context[context.length - 1];
      (currentContext === tc.j_oTag || currentContext === tc.j_expr) && context.pop();
    }
    if (jsx?.error || this.match(tt.lt)) {
      state = state || this.state.clone();
      let typeParameters;
      const arrow = this.tryParse((abort) => {
        typeParameters = this.flowParseTypeParameterDeclaration();
        const arrowExpression2 = this.forwardNoArrowParamsConversionAt(typeParameters, () => {
          const result = super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
          return this.resetStartLocationFromNode(result, typeParameters), result;
        });
        arrowExpression2.extra?.parenthesized && abort();
        const expr = this.maybeUnwrapTypeCastExpression(arrowExpression2);
        return expr.type !== "ArrowFunctionExpression" && abort(), expr.typeParameters = typeParameters, this.resetStartLocationFromNode(expr, typeParameters), arrowExpression2;
      }, state);
      let arrowExpression = null;
      if (arrow.node && this.maybeUnwrapTypeCastExpression(arrow.node).type === "ArrowFunctionExpression") {
        if (!arrow.error && !arrow.aborted)
          return arrow.node.async && this.raise(FlowErrors.UnexpectedTypeParameterBeforeAsyncArrowFunction, typeParameters), arrow.node;
        arrowExpression = arrow.node;
      }
      if (jsx?.node)
        return this.state = jsx.failState, jsx.node;
      if (arrowExpression)
        return this.state = arrow.failState, arrowExpression;
      throw jsx?.thrown ? jsx.error : arrow.thrown ? arrow.error : this.raise(FlowErrors.UnexpectedTokenAfterTypeParameter, typeParameters);
    }
    return super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
  }
  parseArrow(node) {
    if (this.match(tt.colon)) {
      const result = this.tryParse(() => {
        const oldNoAnonFunctionType = this.state.noAnonFunctionType;
        this.state.noAnonFunctionType = !0;
        const typeNode = this.startNode();
        return [typeNode.typeAnnotation, node.predicate] = this.flowParseTypeAndPredicateInitialiser(), this.state.noAnonFunctionType = oldNoAnonFunctionType, this.canInsertSemicolon() && this.unexpected(), this.match(tt.arrow) || this.unexpected(), typeNode;
      });
      if (result.thrown) return null;
      result.error && (this.state = result.failState), node.returnType = result.node.typeAnnotation ? this.finishNode(result.node, "TypeAnnotation") : null;
    }
    return super.parseArrow(node);
  }
  shouldParseArrow(params) {
    return this.match(tt.colon) || super.shouldParseArrow(params);
  }
  setArrowFunctionParameters(node, params) {
    this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start)) ? node.params = params : super.setArrowFunctionParameters(node, params);
  }
  checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged = !0) {
    if (!(isArrowFunction && this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start)))) {
      for (let i = 0; i < node.params.length; i++)
        this.isThisParam(node.params[i]) && i > 0 && this.raise(FlowErrors.ThisParamMustBeFirst, node.params[i]);
      super.checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged);
    }
  }
  parseParenAndDistinguishExpression(canBeArrow) {
    return super.parseParenAndDistinguishExpression(canBeArrow && !this.state.noArrowAt.includes(this.sourceToOffsetPos(this.state.start)));
  }
  parseSubscripts(base, startLoc, noCalls) {
    if (base.type === "Identifier" && base.name === "async" && this.state.noArrowAt.includes(startLoc.index)) {
      this.next();
      const node = this.startNodeAt(startLoc);
      node.callee = base, node.arguments = super.parseCallExpressionArguments(), base = this.finishNode(node, "CallExpression");
    } else if (base.type === "Identifier" && base.name === "async" && this.match(tt.lt)) {
      const state = this.state.clone(), arrow = this.tryParse((abort) => this.parseAsyncArrowWithTypeParameters(startLoc) || abort(), state);
      if (!arrow.error && !arrow.aborted) return arrow.node;
      const result = this.tryParse(() => super.parseSubscripts(base, startLoc, noCalls), state);
      if (result.node && !result.error) return result.node;
      if (arrow.node)
        return this.state = arrow.failState, arrow.node;
      if (result.node)
        return this.state = result.failState, result.node;
      throw arrow.error || result.error;
    }
    return super.parseSubscripts(base, startLoc, noCalls);
  }
  parseSubscript(base, startLoc, noCalls, subscriptState) {
    if (this.match(tt.questionDot) && this.isLookaheadToken_lt()) {
      if (subscriptState.optionalChainMember = !0, noCalls)
        return subscriptState.stop = !0, base;
      this.next();
      const node = this.startNodeAt(startLoc);
      return node.callee = base, node.typeArguments = this.flowParseTypeParameterInstantiationInExpression(), this.expect(tt.parenL), node.arguments = this.parseCallExpressionArguments(), node.optional = !0, this.finishCallExpression(node, !0);
    } else if (!noCalls && this.shouldParseTypes() && (this.match(tt.lt) || this.match(tt.bitShiftL))) {
      const node = this.startNodeAt(startLoc);
      node.callee = base;
      const result = this.tryParse(() => (node.typeArguments = this.flowParseTypeParameterInstantiationCallOrNew(), this.expect(tt.parenL), node.arguments = super.parseCallExpressionArguments(), subscriptState.optionalChainMember && (node.optional = !1), this.finishCallExpression(node, subscriptState.optionalChainMember)));
      if (result.node)
        return result.error && (this.state = result.failState), result.node;
    }
    return super.parseSubscript(base, startLoc, noCalls, subscriptState);
  }
  parseNewCallee(node) {
    super.parseNewCallee(node);
    let targs = null;
    this.shouldParseTypes() && this.match(tt.lt) && (targs = this.tryParse(() => this.flowParseTypeParameterInstantiationCallOrNew()).node), node.typeArguments = targs;
  }
  parseAsyncArrowWithTypeParameters(startLoc) {
    const node = this.startNodeAt(startLoc);
    if (this.parseFunctionParams(node, !1), !!this.parseArrow(node))
      return super.parseArrowExpression(node, void 0, !0);
  }
  readToken_mult_modulo(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (code === 42 && next === 47 && this.state.hasFlowComment) {
      this.state.hasFlowComment = !1, this.state.pos += 2, this.nextToken();
      return;
    }
    super.readToken_mult_modulo(code);
  }
  readToken_pipe_amp(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (code === 124 && next === 125) {
      this.finishOp(tt.braceBarR, 2);
      return;
    }
    super.readToken_pipe_amp(code);
  }
  parseTopLevel(file, program) {
    const fileNode = super.parseTopLevel(file, program);
    return this.state.hasFlowComment && this.raise(FlowErrors.UnterminatedFlowComment, this.state.curPosition()), fileNode;
  }
  skipBlockComment() {
    if (this.hasPlugin("flowComments") && this.skipFlowComment()) {
      if (this.state.hasFlowComment)
        throw this.raise(FlowErrors.NestedFlowComment, this.state.startLoc);
      this.hasFlowCommentCompletion();
      const commentSkip = this.skipFlowComment();
      commentSkip && (this.state.pos += commentSkip, this.state.hasFlowComment = !0);
      return;
    }
    return super.skipBlockComment(this.state.hasFlowComment ? "*-/" : "*/");
  }
  skipFlowComment() {
    const {
      pos
    } = this.state;
    let shiftToFirstNonWhiteSpace = 2;
    for (; [32, 9].includes(this.input.charCodeAt(pos + shiftToFirstNonWhiteSpace)); )
      shiftToFirstNonWhiteSpace++;
    const ch2 = this.input.charCodeAt(shiftToFirstNonWhiteSpace + pos), ch3 = this.input.charCodeAt(shiftToFirstNonWhiteSpace + pos + 1);
    return ch2 === 58 && ch3 === 58 ? shiftToFirstNonWhiteSpace + 2 : this.input.slice(shiftToFirstNonWhiteSpace + pos, shiftToFirstNonWhiteSpace + pos + 12) === "flow-include" ? shiftToFirstNonWhiteSpace + 12 : ch2 === 58 && ch3 !== 58 ? shiftToFirstNonWhiteSpace : !1;
  }
  hasFlowCommentCompletion() {
    if (this.input.indexOf("*/", this.state.pos) === -1)
      throw this.raise(Errors.UnterminatedComment, this.state.curPosition());
  }
  flowEnumErrorBooleanMemberNotInitialized(loc, {
    enumName,
    memberName
  }) {
    this.raise(FlowErrors.EnumBooleanMemberNotInitialized, loc, {
      memberName,
      enumName
    });
  }
  flowEnumErrorInvalidMemberInitializer(loc, enumContext) {
    return this.raise(enumContext.explicitType ? enumContext.explicitType === "symbol" ? FlowErrors.EnumInvalidMemberInitializerSymbolType : FlowErrors.EnumInvalidMemberInitializerPrimaryType : FlowErrors.EnumInvalidMemberInitializerUnknownType, loc, enumContext);
  }
  flowEnumErrorNumberMemberNotInitialized(loc, details) {
    this.raise(FlowErrors.EnumNumberMemberNotInitialized, loc, details);
  }
  flowEnumErrorStringMemberInconsistentlyInitialized(node, details) {
    this.raise(FlowErrors.EnumStringMemberInconsistentlyInitialized, node, details);
  }
  flowEnumMemberInit() {
    const startLoc = this.state.startLoc, endOfInit = () => this.match(tt.comma) || this.match(tt.braceR);
    switch (this.state.type) {
      case tt.num: {
        const literal = this.parseNumericLiteral(this.state.value);
        return endOfInit() ? {
          type: "number",
          loc: literal.loc.start,
          value: literal
        } : {
          type: "invalid",
          loc: startLoc
        };
      }
      case tt.string: {
        const literal = this.parseStringLiteral(this.state.value);
        return endOfInit() ? {
          type: "string",
          loc: literal.loc.start,
          value: literal
        } : {
          type: "invalid",
          loc: startLoc
        };
      }
      case tt._true:
      case tt._false: {
        const literal = this.parseBooleanLiteral(this.match(tt._true));
        return endOfInit() ? {
          type: "boolean",
          loc: literal.loc.start,
          value: literal
        } : {
          type: "invalid",
          loc: startLoc
        };
      }
      default:
        return {
          type: "invalid",
          loc: startLoc
        };
    }
  }
  flowEnumMemberRaw() {
    const loc = this.state.startLoc, id = this.parseIdentifier(!0), init = this.eat(tt.eq) ? this.flowEnumMemberInit() : {
      type: "none",
      loc
    };
    return {
      id,
      init
    };
  }
  flowEnumCheckExplicitTypeMismatch(loc, context, expectedType) {
    const {
      explicitType
    } = context;
    explicitType !== null && explicitType !== expectedType && this.flowEnumErrorInvalidMemberInitializer(loc, context);
  }
  flowEnumMembers({
    enumName,
    explicitType
  }) {
    const seenNames = /* @__PURE__ */ new Set(), members = {
      booleanMembers: [],
      numberMembers: [],
      stringMembers: [],
      defaultedMembers: []
    };
    let hasUnknownMembers = !1;
    for (; !this.match(tt.braceR); ) {
      if (this.eat(tt.ellipsis)) {
        hasUnknownMembers = !0;
        break;
      }
      const memberNode = this.startNode(), {
        id,
        init
      } = this.flowEnumMemberRaw(), memberName = id.name;
      if (memberName === "")
        continue;
      /^[a-z]/.test(memberName) && this.raise(FlowErrors.EnumInvalidMemberName, id, {
        memberName,
        suggestion: memberName[0].toUpperCase() + memberName.slice(1),
        enumName
      }), seenNames.has(memberName) && this.raise(FlowErrors.EnumDuplicateMemberName, id, {
        memberName,
        enumName
      }), seenNames.add(memberName);
      const context = {
        enumName,
        explicitType,
        memberName
      };
      switch (memberNode.id = id, init.type) {
        case "boolean": {
          this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "boolean"), memberNode.init = init.value, members.booleanMembers.push(this.finishNode(memberNode, "EnumBooleanMember"));
          break;
        }
        case "number": {
          this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "number"), memberNode.init = init.value, members.numberMembers.push(this.finishNode(memberNode, "EnumNumberMember"));
          break;
        }
        case "string": {
          this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "string"), memberNode.init = init.value, members.stringMembers.push(this.finishNode(memberNode, "EnumStringMember"));
          break;
        }
        case "invalid":
          throw this.flowEnumErrorInvalidMemberInitializer(init.loc, context);
        case "none":
          switch (explicitType) {
            case "boolean":
              this.flowEnumErrorBooleanMemberNotInitialized(init.loc, context);
              break;
            case "number":
              this.flowEnumErrorNumberMemberNotInitialized(init.loc, context);
              break;
            default:
              members.defaultedMembers.push(this.finishNode(memberNode, "EnumDefaultedMember"));
          }
      }
      this.match(tt.braceR) || this.expect(tt.comma);
    }
    return {
      members,
      hasUnknownMembers
    };
  }
  flowEnumStringMembers(initializedMembers, defaultedMembers, {
    enumName
  }) {
    if (initializedMembers.length === 0)
      return defaultedMembers;
    if (defaultedMembers.length === 0)
      return initializedMembers;
    if (defaultedMembers.length > initializedMembers.length) {
      for (const member of initializedMembers)
        this.flowEnumErrorStringMemberInconsistentlyInitialized(member, {
          enumName
        });
      return defaultedMembers;
    } else {
      for (const member of defaultedMembers)
        this.flowEnumErrorStringMemberInconsistentlyInitialized(member, {
          enumName
        });
      return initializedMembers;
    }
  }
  flowEnumParseExplicitType({
    enumName
  }) {
    if (!this.eatContextual(tt._of)) return null;
    if (!tokenIsIdentifier(this.state.type))
      throw this.raise(FlowErrors.EnumInvalidExplicitTypeUnknownSupplied, this.state.startLoc, {
        enumName
      });
    const {
      value
    } = this.state;
    return this.next(), value !== "boolean" && value !== "number" && value !== "string" && value !== "symbol" && this.raise(FlowErrors.EnumInvalidExplicitType, this.state.startLoc, {
      enumName,
      invalidEnumType: value
    }), value;
  }
  flowEnumBody(node, id) {
    const enumName = id.name, nameLoc = id.loc.start, explicitType = this.flowEnumParseExplicitType({
      enumName
    });
    this.expect(tt.braceL);
    const {
      members,
      hasUnknownMembers
    } = this.flowEnumMembers({
      enumName,
      explicitType
    });
    switch (node.hasUnknownMembers = hasUnknownMembers, explicitType) {
      case "boolean":
        return node.explicitType = !0, node.members = members.booleanMembers, this.expect(tt.braceR), this.finishNode(node, "EnumBooleanBody");
      case "number":
        return node.explicitType = !0, node.members = members.numberMembers, this.expect(tt.braceR), this.finishNode(node, "EnumNumberBody");
      case "string":
        return node.explicitType = !0, node.members = this.flowEnumStringMembers(members.stringMembers, members.defaultedMembers, {
          enumName
        }), this.expect(tt.braceR), this.finishNode(node, "EnumStringBody");
      case "symbol":
        return node.members = members.defaultedMembers, this.expect(tt.braceR), this.finishNode(node, "EnumSymbolBody");
      default: {
        const empty = () => (node.members = [], this.expect(tt.braceR), this.finishNode(node, "EnumStringBody"));
        node.explicitType = !1;
        const boolsLen = members.booleanMembers.length, numsLen = members.numberMembers.length, strsLen = members.stringMembers.length, defaultedLen = members.defaultedMembers.length;
        if (!boolsLen && !numsLen && !strsLen && !defaultedLen)
          return empty();
        if (!boolsLen && !numsLen)
          return node.members = this.flowEnumStringMembers(members.stringMembers, members.defaultedMembers, {
            enumName
          }), this.expect(tt.braceR), this.finishNode(node, "EnumStringBody");
        if (!numsLen && !strsLen && boolsLen >= defaultedLen) {
          for (const member of members.defaultedMembers)
            this.flowEnumErrorBooleanMemberNotInitialized(member.loc.start, {
              enumName,
              memberName: member.id.name
            });
          return node.members = members.booleanMembers, this.expect(tt.braceR), this.finishNode(node, "EnumBooleanBody");
        } else if (!boolsLen && !strsLen && numsLen >= defaultedLen) {
          for (const member of members.defaultedMembers)
            this.flowEnumErrorNumberMemberNotInitialized(member.loc.start, {
              enumName,
              memberName: member.id.name
            });
          return node.members = members.numberMembers, this.expect(tt.braceR), this.finishNode(node, "EnumNumberBody");
        } else
          return this.raise(FlowErrors.EnumInconsistentMemberValues, nameLoc, {
            enumName
          }), empty();
      }
    }
  }
  flowParseEnumDeclaration(node) {
    const id = this.parseIdentifier();
    return node.id = id, node.body = this.flowEnumBody(this.startNode(), id), this.finishNode(node, "EnumDeclaration");
  }
  jsxParseOpeningElementAfterName(node) {
    return this.shouldParseTypes() && (this.match(tt.lt) || this.match(tt.bitShiftL)) && (node.typeArguments = this.flowParseTypeParameterInstantiationInExpression()), super.jsxParseOpeningElementAfterName(node);
  }
  isLookaheadToken_lt() {
    const next = this.nextTokenStart();
    if (this.input.charCodeAt(next) === 60) {
      const afterNext = this.input.charCodeAt(next + 1);
      return afterNext !== 60 && afterNext !== 61;
    }
    return !1;
  }
  reScan_lt_gt() {
    const {
      type
    } = this.state;
    type === tt.lt ? (this.state.pos -= 1, this.readToken_lt()) : type === tt.gt && (this.state.pos -= 1, this.readToken_gt());
  }
  reScan_lt() {
    const {
      type
    } = this.state;
    return type === tt.bitShiftL ? (this.state.pos -= 2, this.finishOp(tt.lt, 1), tt.lt) : type;
  }
  maybeUnwrapTypeCastExpression(node) {
    return node.type === "TypeCastExpression" ? node.expression : node;
  }
};
export {
  stdin_default as default
};
