// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenIsIdentifier, tokenIsTSDeclarationStart, tokenIsTSTypeOperator, tokenOperatorPrecedence, tokenIsKeywordOrIdentifier, tt, tokenIsTemplate, tokenCanStartExpression } from "../../tokenizer/types.mjs";
import { types as tc } from "../../tokenizer/context.mjs";
import "../../util/location.mjs";
import { ScopeFlag, BindingFlag } from "../../util/scopeflags.mjs";
import TypeScriptScopeHandler from "./scope.mjs";
import { ParamKind } from "../../util/production-parameter.mjs";
import { Errors, ParseErrorEnum } from "../../parse-error.mjs";
import { ParseBindingListFlags } from "../../parser/lval.mjs";
import "../../options.mjs";
import { isIdentifierChar, isIdentifierStart } from "../../util/identifier.mjs";
const keywordAndTSRelationalOperator = /in(?:stanceof)?|as|satisfies/y;
function nonNull(x) {
  if (x == null)
    throw new Error(`Unexpected ${x} value.`);
  return x;
}
function assert(x) {
  if (!x)
    throw new Error("Assert fail");
}
const TSErrors = ParseErrorEnum`typescript`({
  AbstractMethodHasImplementation: ({
    methodName
  }) => `Method '${methodName}' cannot have an implementation because it is marked abstract.`,
  AbstractPropertyHasInitializer: ({
    propertyName
  }) => `Property '${propertyName}' cannot have an initializer because it is marked abstract.`,
  AccessorCannotBeOptional: "An 'accessor' property cannot be declared optional.",
  AccessorCannotDeclareThisParameter: "'get' and 'set' accessors cannot declare 'this' parameters.",
  AccessorCannotHaveTypeParameters: "An accessor cannot have type parameters.",
  ClassMethodHasDeclare: "Class methods cannot have the 'declare' modifier.",
  ClassMethodHasReadonly: "Class methods cannot have the 'readonly' modifier.",
  ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference: "A 'const' initializer in an ambient context must be a string or numeric literal or literal enum reference.",
  ConstructorHasTypeParameters: "Type parameters cannot appear on a constructor declaration.",
  DeclareAccessor: ({
    kind
  }) => `'declare' is not allowed in ${kind}ters.`,
  DeclareClassFieldHasInitializer: "Initializers are not allowed in ambient contexts.",
  DeclareFunctionHasImplementation: "An implementation cannot be declared in ambient contexts.",
  DuplicateAccessibilityModifier: ({
    modifier
  }) => `Accessibility modifier already seen: '${modifier}'.`,
  DuplicateModifier: ({
    modifier
  }) => `Duplicate modifier: '${modifier}'.`,
  EmptyHeritageClauseType: ({
    token
  }) => `'${token}' list cannot be empty.`,
  EmptyTypeArguments: "Type argument list cannot be empty.",
  EmptyTypeParameters: "Type parameter list cannot be empty.",
  ExpectedAmbientAfterExportDeclare: "'export declare' must be followed by an ambient declaration.",
  ImportAliasHasImportType: "An import alias can not use 'import type'.",
  ImportReflectionHasImportType: "An `import module` declaration can not use `type` modifier",
  IncompatibleModifiers: ({
    modifiers
  }) => `'${modifiers[0]}' modifier cannot be used with '${modifiers[1]}' modifier.`,
  IndexSignatureHasAbstract: "Index signatures cannot have the 'abstract' modifier.",
  IndexSignatureHasAccessibility: ({
    modifier
  }) => `Index signatures cannot have an accessibility modifier ('${modifier}').`,
  IndexSignatureHasDeclare: "Index signatures cannot have the 'declare' modifier.",
  IndexSignatureHasOverride: "'override' modifier cannot appear on an index signature.",
  IndexSignatureHasStatic: "Index signatures cannot have the 'static' modifier.",
  InitializerNotAllowedInAmbientContext: "Initializers are not allowed in ambient contexts.",
  InvalidHeritageClauseType: ({
    token
  }) => `'${token}' list can only include identifiers or qualified-names with optional type arguments.`,
  InvalidModifierOnAwaitUsingDeclaration: (modifier) => `'${modifier}' modifier cannot appear on an await using declaration.`,
  InvalidModifierOnTypeMember: ({
    modifier
  }) => `'${modifier}' modifier cannot appear on a type member.`,
  InvalidModifierOnTypeParameter: ({
    modifier
  }) => `'${modifier}' modifier cannot appear on a type parameter.`,
  InvalidModifierOnTypeParameterPositions: ({
    modifier
  }) => `'${modifier}' modifier can only appear on a type parameter of a class, interface or type alias.`,
  InvalidModifierOnUsingDeclaration: (modifier) => `'${modifier}' modifier cannot appear on a using declaration.`,
  InvalidModifiersOrder: ({
    orderedModifiers
  }) => `'${orderedModifiers[0]}' modifier must precede '${orderedModifiers[1]}' modifier.`,
  InvalidPropertyAccessAfterInstantiationExpression: "Invalid property access after an instantiation expression. You can either wrap the instantiation expression in parentheses, or delete the type arguments.",
  InvalidTupleMemberLabel: "Tuple members must be labeled with a simple identifier.",
  MissingInterfaceName: "'interface' declarations must be followed by an identifier.",
  NonAbstractClassHasAbstractMethod: "Abstract methods can only appear within an abstract class.",
  NonClassMethodPropertyHasAbstractModifier: "'abstract' modifier can only appear on a class, method, or property declaration.",
  OptionalTypeBeforeRequired: "A required element cannot follow an optional element.",
  OverrideNotInSubClass: "This member cannot have an 'override' modifier because its containing class does not extend another class.",
  PatternIsOptional: "A binding pattern parameter cannot be optional in an implementation signature.",
  PrivateElementHasAbstract: "Private elements cannot have the 'abstract' modifier.",
  PrivateElementHasAccessibility: ({
    modifier
  }) => `Private elements cannot have an accessibility modifier ('${modifier}').`,
  ReadonlyForMethodSignature: "'readonly' modifier can only appear on a property declaration or index signature.",
  ReservedArrowTypeParam: "This syntax is reserved in files with the .mts or .cts extension. Add a trailing comma, as in `<T,>() => ...`.",
  ReservedTypeAssertion: "This syntax is reserved in files with the .mts or .cts extension. Use an `as` expression instead.",
  SetAccessorCannotHaveOptionalParameter: "A 'set' accessor cannot have an optional parameter.",
  SetAccessorCannotHaveRestParameter: "A 'set' accessor cannot have rest parameter.",
  SetAccessorCannotHaveReturnType: "A 'set' accessor cannot have a return type annotation.",
  SingleTypeParameterWithoutTrailingComma: ({
    typeParameterName
  }) => `Single type parameter ${typeParameterName} should have a trailing comma. Example usage: <${typeParameterName},>.`,
  StaticBlockCannotHaveModifier: "Static class blocks cannot have any modifier.",
  TupleOptionalAfterType: "A labeled tuple optional element must be declared using a question mark after the name and before the colon (`name?: type`), rather than after the type (`name: type?`).",
  TypeAnnotationAfterAssign: "Type annotations must come before default assignments, e.g. instead of `age = 25: number` use `age: number = 25`.",
  TypeImportCannotSpecifyDefaultAndNamed: "A type-only import can specify a default import or named bindings, but not both.",
  TypeModifierIsUsedInTypeExports: "The 'type' modifier cannot be used on a named export when 'export type' is used on its export statement.",
  TypeModifierIsUsedInTypeImports: "The 'type' modifier cannot be used on a named import when 'import type' is used on its import statement.",
  UnexpectedParameterModifier: "A parameter property is only allowed in a constructor implementation.",
  UnexpectedReadonly: "'readonly' type modifier is only permitted on array and tuple literal types.",
  UnexpectedTypeAnnotation: "Did not expect a type annotation here.",
  UnexpectedTypeCastInParameter: "Unexpected type cast in parameter position.",
  UnsupportedImportTypeArgument: "Argument in a type import must be a string literal.",
  UnsupportedParameterPropertyKind: "A parameter property may not be declared using a binding pattern.",
  UnsupportedSignatureParameterKind: ({
    type
  }) => `Name in a signature must be an Identifier, ObjectPattern or ArrayPattern, instead got ${type}.`,
  UsingDeclarationInAmbientContext: (kind) => `'${kind}' declarations are not allowed in ambient contexts.`
});
function keywordTypeFromName(value) {
  switch (value) {
    case "any":
      return "TSAnyKeyword";
    case "boolean":
      return "TSBooleanKeyword";
    case "bigint":
      return "TSBigIntKeyword";
    case "never":
      return "TSNeverKeyword";
    case "number":
      return "TSNumberKeyword";
    case "object":
      return "TSObjectKeyword";
    case "string":
      return "TSStringKeyword";
    case "symbol":
      return "TSSymbolKeyword";
    case "undefined":
      return "TSUndefinedKeyword";
    case "unknown":
      return "TSUnknownKeyword";
    default:
      return;
  }
}
function tsIsAccessModifier(modifier) {
  return modifier === "private" || modifier === "public" || modifier === "protected";
}
function tsIsVarianceAnnotations(modifier) {
  return modifier === "in" || modifier === "out";
}
function tsIsEntityName(node) {
  if (node.extra?.parenthesized)
    return !1;
  switch (node.type) {
    case "Identifier":
      return !0;
    case "MemberExpression":
      return !node.computed && tsIsEntityName(node.object);
    case "TSInstantiationExpression":
      return tsIsEntityName(node.expression);
    default:
      return !1;
  }
}
var tsParseEntityNameFlags = {
  NONE: 0,
  ALLOW_RESERVED_WORDS: 1,
  LEADING_THIS_AS_IDENTIFIER: 2
}, stdin_default = (superClass) => class extends superClass {
  getScopeHandler() {
    return TypeScriptScopeHandler;
  }
  tsIsIdentifier() {
    return tokenIsIdentifier(this.state.type);
  }
  tsTokenCanFollowModifier() {
    return this.match(tt.bracketL) || this.match(tt.braceL) || this.match(tt.star) || this.match(tt.ellipsis) || this.match(tt.privateName) || this.isLiteralPropertyName();
  }
  tsNextTokenOnSameLineAndCanFollowModifier() {
    return this.next(), this.hasPrecedingLineBreak() ? !1 : this.tsTokenCanFollowModifier();
  }
  tsNextTokenCanFollowModifier() {
    return this.match(tt._static) ? (this.next(), this.tsTokenCanFollowModifier()) : this.tsNextTokenOnSameLineAndCanFollowModifier();
  }
  tsParseModifier(allowedModifiers, stopOnStartOfClassStaticBlock, hasSeenStaticModifier) {
    if (!tokenIsIdentifier(this.state.type) && this.state.type !== tt._in && this.state.type !== tt._const)
      return;
    const modifier = this.state.value;
    if (allowedModifiers.includes(modifier)) {
      if (hasSeenStaticModifier && this.match(tt._static) || stopOnStartOfClassStaticBlock && this.tsIsStartOfStaticBlocks())
        return;
      if (this.tsTryParse(this.tsNextTokenCanFollowModifier.bind(this)))
        return modifier;
    }
  }
  tsParseModifiers({
    allowedModifiers,
    disallowedModifiers,
    stopOnStartOfClassStaticBlock,
    errorTemplate = TSErrors.InvalidModifierOnTypeMember
  }, modified) {
    const enforceOrder = (loc, modifier, before, after) => {
      modifier === before && modified[after] && this.raise(TSErrors.InvalidModifiersOrder, loc, {
        orderedModifiers: [before, after]
      });
    }, incompatible = (loc, modifier, mod1, mod2) => {
      (modified[mod1] && modifier === mod2 || modified[mod2] && modifier === mod1) && this.raise(TSErrors.IncompatibleModifiers, loc, {
        modifiers: [mod1, mod2]
      });
    };
    for (; ; ) {
      const {
        startLoc
      } = this.state, modifier = this.tsParseModifier(allowedModifiers.concat(disallowedModifiers ?? []), stopOnStartOfClassStaticBlock, modified.static);
      if (!modifier) break;
      tsIsAccessModifier(modifier) ? modified.accessibility ? this.raise(TSErrors.DuplicateAccessibilityModifier, startLoc, {
        modifier
      }) : (enforceOrder(startLoc, modifier, modifier, "override"), enforceOrder(startLoc, modifier, modifier, "static"), enforceOrder(startLoc, modifier, modifier, "readonly"), modified.accessibility = modifier) : tsIsVarianceAnnotations(modifier) ? (modified[modifier] && this.raise(TSErrors.DuplicateModifier, startLoc, {
        modifier
      }), modified[modifier] = !0, enforceOrder(startLoc, modifier, "in", "out")) : (Object.hasOwn(modified, modifier) ? this.raise(TSErrors.DuplicateModifier, startLoc, {
        modifier
      }) : (enforceOrder(startLoc, modifier, "static", "readonly"), enforceOrder(startLoc, modifier, "static", "override"), enforceOrder(startLoc, modifier, "override", "readonly"), enforceOrder(startLoc, modifier, "abstract", "override"), incompatible(startLoc, modifier, "declare", "override"), incompatible(startLoc, modifier, "static", "abstract")), modified[modifier] = !0), disallowedModifiers?.includes(modifier) && this.raise(errorTemplate, startLoc, {
        modifier
      });
    }
  }
  tsIsListTerminator(kind) {
    switch (kind) {
      case "EnumMembers":
      case "TypeMembers":
        return this.match(tt.braceR);
      case "HeritageClauseElement":
        return this.match(tt.braceL);
      case "TupleElementTypes":
        return this.match(tt.bracketR);
      case "TypeParametersOrArguments":
        return this.match(tt.gt);
    }
  }
  tsParseList(kind, parseElement) {
    const result = [];
    for (; !this.tsIsListTerminator(kind); )
      result.push(parseElement());
    return result;
  }
  tsParseDelimitedList(kind, parseElement, refTrailingCommaPos) {
    return nonNull(this.tsParseDelimitedListWorker(kind, parseElement, !0, refTrailingCommaPos));
  }
  tsParseDelimitedListWorker(kind, parseElement, expectSuccess, refTrailingCommaPos) {
    const result = [];
    let trailingCommaPos = -1;
    for (; !this.tsIsListTerminator(kind); ) {
      trailingCommaPos = -1;
      const element = parseElement();
      if (element == null)
        return;
      if (result.push(element), this.eat(tt.comma)) {
        trailingCommaPos = this.state.lastTokStartLoc.index;
        continue;
      }
      if (this.tsIsListTerminator(kind))
        break;
      expectSuccess && this.expect(tt.comma);
      return;
    }
    return refTrailingCommaPos && (refTrailingCommaPos.value = trailingCommaPos), result;
  }
  tsParseBracketedList(kind, parseElement, bracket, skipFirstToken, refTrailingCommaPos) {
    skipFirstToken || (bracket ? this.expect(tt.bracketL) : this.expect(tt.lt));
    const result = this.tsParseDelimitedList(kind, parseElement, refTrailingCommaPos);
    return bracket ? this.expect(tt.bracketR) : this.expect(tt.gt), result;
  }
  tsParseImportType() {
    const node = this.startNode();
    return this.expect(tt._import), this.expect(tt.parenL), this.match(tt.string) ? node.argument = this.parseStringLiteral(this.state.value) : (this.raise(TSErrors.UnsupportedImportTypeArgument, this.state.startLoc), node.argument = super.parseExprAtom()), this.eat(tt.comma) ? node.options = this.tsParseImportTypeOptions() : node.options = null, this.expect(tt.parenR), this.eat(tt.dot) && (node.qualifier = this.tsParseEntityName(tsParseEntityNameFlags.ALLOW_RESERVED_WORDS | tsParseEntityNameFlags.LEADING_THIS_AS_IDENTIFIER)), this.match(tt.lt) && (node.typeParameters = this.tsParseTypeArguments()), this.finishNode(node, "TSImportType");
  }
  tsParseImportTypeOptions() {
    const node = this.startNode();
    this.expect(tt.braceL);
    const withProperty = this.startNode();
    return this.isContextual(tt._with) ? (withProperty.method = !1, withProperty.key = this.parseIdentifier(!0), withProperty.computed = !1, withProperty.shorthand = !1) : this.unexpected(null, tt._with), this.expect(tt.colon), withProperty.value = this.tsParseImportTypeWithPropertyValue(), node.properties = [this.finishObjectProperty(withProperty)], this.eat(tt.comma), this.expect(tt.braceR), this.finishNode(node, "ObjectExpression");
  }
  tsParseImportTypeWithPropertyValue() {
    const node = this.startNode(), properties = [];
    for (this.expect(tt.braceL); !this.match(tt.braceR); ) {
      const type = this.state.type;
      tokenIsIdentifier(type) || type === tt.string ? properties.push(super.parsePropertyDefinition(null)) : this.unexpected(), this.eat(tt.comma);
    }
    return node.properties = properties, this.next(), this.finishNode(node, "ObjectExpression");
  }
  tsParseEntityName(flags) {
    let entity;
    if (flags & tsParseEntityNameFlags.ALLOW_RESERVED_WORDS && this.match(tt._this))
      if (flags & tsParseEntityNameFlags.LEADING_THIS_AS_IDENTIFIER)
        entity = this.parseIdentifier(!0);
      else {
        const node = this.startNode();
        this.next(), entity = this.finishNode(node, "ThisExpression");
      }
    else
      entity = this.parseIdentifier(!!(flags & tsParseEntityNameFlags.ALLOW_RESERVED_WORDS));
    for (; this.eat(tt.dot); ) {
      const node = this.startNodeAtNode(entity);
      node.left = entity, node.right = this.parseIdentifier(!!(flags & tsParseEntityNameFlags.ALLOW_RESERVED_WORDS)), entity = this.finishNode(node, "TSQualifiedName");
    }
    return entity;
  }
  tsParseTypeReference() {
    const node = this.startNode();
    return node.typeName = this.tsParseEntityName(tsParseEntityNameFlags.ALLOW_RESERVED_WORDS), !this.hasPrecedingLineBreak() && this.match(tt.lt) && (node.typeParameters = this.tsParseTypeArguments()), this.finishNode(node, "TSTypeReference");
  }
  tsParseThisTypePredicate(lhs) {
    this.next();
    const node = this.startNodeAtNode(lhs);
    return node.parameterName = lhs, node.typeAnnotation = this.tsParseTypeAnnotation(!1), node.asserts = !1, this.finishNode(node, "TSTypePredicate");
  }
  tsParseThisTypeNode() {
    const node = this.startNode();
    return this.next(), this.finishNode(node, "TSThisType");
  }
  tsParseTypeQuery() {
    const node = this.startNode();
    return this.expect(tt._typeof), this.match(tt._import) ? node.exprName = this.tsParseImportType() : node.exprName = this.tsParseEntityName(tsParseEntityNameFlags.ALLOW_RESERVED_WORDS | tsParseEntityNameFlags.LEADING_THIS_AS_IDENTIFIER), !this.hasPrecedingLineBreak() && this.match(tt.lt) && (node.typeParameters = this.tsParseTypeArguments()), this.finishNode(node, "TSTypeQuery");
  }
  tsParseInOutModifiers = this.tsParseModifiers.bind(this, {
    allowedModifiers: ["in", "out"],
    disallowedModifiers: ["const", "public", "private", "protected", "readonly", "declare", "abstract", "override"],
    errorTemplate: TSErrors.InvalidModifierOnTypeParameter
  });
  tsParseConstModifier = this.tsParseModifiers.bind(this, {
    allowedModifiers: ["const"],
    disallowedModifiers: ["in", "out"],
    errorTemplate: TSErrors.InvalidModifierOnTypeParameterPositions
  });
  tsParseInOutConstModifiers = this.tsParseModifiers.bind(this, {
    allowedModifiers: ["in", "out", "const"],
    disallowedModifiers: ["public", "private", "protected", "readonly", "declare", "abstract", "override"],
    errorTemplate: TSErrors.InvalidModifierOnTypeParameter
  });
  tsParseTypeParameter(parseModifiers) {
    const node = this.startNode();
    return parseModifiers(node), node.name = this.tsParseTypeParameterName(), node.constraint = this.tsEatThenParseType(tt._extends), node.default = this.tsEatThenParseType(tt.eq), this.finishNode(node, "TSTypeParameter");
  }
  tsTryParseTypeParameters(parseModifiers) {
    if (this.match(tt.lt))
      return this.tsParseTypeParameters(parseModifiers);
  }
  tsParseTypeParameters(parseModifiers) {
    const node = this.startNode();
    this.match(tt.lt) || this.match(tt.jsxTagStart) ? this.next() : this.unexpected();
    const refTrailingCommaPos = {
      value: -1
    };
    return node.params = this.tsParseBracketedList("TypeParametersOrArguments", this.tsParseTypeParameter.bind(this, parseModifiers), !1, !0, refTrailingCommaPos), node.params.length === 0 && this.raise(TSErrors.EmptyTypeParameters, node), refTrailingCommaPos.value !== -1 && this.addExtra(node, "trailingComma", refTrailingCommaPos.value), this.finishNode(node, "TSTypeParameterDeclaration");
  }
  tsFillSignature(returnToken, signature) {
    const returnTokenRequired = returnToken === tt.arrow, paramsKey = "parameters", returnTypeKey = "typeAnnotation";
    signature.typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier), this.expect(tt.parenL), signature[paramsKey] = this.tsParseBindingListForSignature(), returnTokenRequired ? signature[returnTypeKey] = this.tsParseTypeOrTypePredicateAnnotation(returnToken) : this.match(returnToken) && (signature[returnTypeKey] = this.tsParseTypeOrTypePredicateAnnotation(returnToken));
  }
  tsParseBindingListForSignature() {
    const list = super.parseBindingList(tt.parenR, 41, ParseBindingListFlags.IS_FUNCTION_PARAMS);
    for (const pattern of list) {
      const {
        type
      } = pattern;
      (type === "AssignmentPattern" || type === "TSParameterProperty") && this.raise(TSErrors.UnsupportedSignatureParameterKind, pattern, {
        type
      });
    }
    return list;
  }
  tsParseTypeMemberSemicolon() {
    !this.eat(tt.comma) && !this.isLineTerminator() && this.expect(tt.semi);
  }
  tsParseSignatureMember(kind, node) {
    return this.tsFillSignature(tt.colon, node), this.tsParseTypeMemberSemicolon(), this.finishNode(node, kind);
  }
  tsIsUnambiguouslyIndexSignature() {
    return this.next(), tokenIsIdentifier(this.state.type) ? (this.next(), this.match(tt.colon)) : !1;
  }
  tsTryParseIndexSignature(node) {
    if (!(this.match(tt.bracketL) && this.tsLookAhead(this.tsIsUnambiguouslyIndexSignature.bind(this))))
      return;
    this.expect(tt.bracketL);
    const id = this.parseIdentifier();
    id.typeAnnotation = this.tsParseTypeAnnotation(), this.resetEndLocation(id), this.expect(tt.bracketR), node.parameters = [id];
    const type = this.tsTryParseTypeAnnotation();
    return type && (node.typeAnnotation = type), this.tsParseTypeMemberSemicolon(), this.finishNode(node, "TSIndexSignature");
  }
  tsParsePropertyOrMethodSignature(node, readonly) {
    if (this.eat(tt.question) && (node.optional = !0), this.match(tt.parenL) || this.match(tt.lt)) {
      readonly && this.raise(TSErrors.ReadonlyForMethodSignature, node);
      const method = node;
      method.kind && this.match(tt.lt) && this.raise(TSErrors.AccessorCannotHaveTypeParameters, this.state.curPosition()), this.tsFillSignature(tt.colon, method), this.tsParseTypeMemberSemicolon();
      const paramsKey = "parameters", returnTypeKey = "typeAnnotation";
      if (method.kind === "get")
        method[paramsKey].length > 0 && (this.raise(Errors.BadGetterArity, this.state.curPosition()), this.isThisParam(method[paramsKey][0]) && this.raise(TSErrors.AccessorCannotDeclareThisParameter, this.state.curPosition()));
      else if (method.kind === "set") {
        if (method[paramsKey].length !== 1)
          this.raise(Errors.BadSetterArity, this.state.curPosition());
        else {
          const firstParameter = method[paramsKey][0];
          this.isThisParam(firstParameter) && this.raise(TSErrors.AccessorCannotDeclareThisParameter, this.state.curPosition()), firstParameter.type === "Identifier" && firstParameter.optional && this.raise(TSErrors.SetAccessorCannotHaveOptionalParameter, this.state.curPosition()), firstParameter.type === "RestElement" && this.raise(TSErrors.SetAccessorCannotHaveRestParameter, this.state.curPosition());
        }
        method[returnTypeKey] && this.raise(TSErrors.SetAccessorCannotHaveReturnType, method[returnTypeKey]);
      } else
        method.kind = "method";
      return this.finishNode(method, "TSMethodSignature");
    } else {
      const property = node;
      readonly && (property.readonly = !0);
      const type = this.tsTryParseTypeAnnotation();
      return type && (property.typeAnnotation = type), this.tsParseTypeMemberSemicolon(), this.finishNode(property, "TSPropertySignature");
    }
  }
  tsParseTypeMember() {
    const node = this.startNode();
    if (this.match(tt.parenL) || this.match(tt.lt))
      return this.tsParseSignatureMember("TSCallSignatureDeclaration", node);
    if (this.match(tt._new)) {
      const id = this.startNode();
      return this.next(), this.match(tt.parenL) || this.match(tt.lt) ? this.tsParseSignatureMember("TSConstructSignatureDeclaration", node) : (node.key = this.createIdentifier(id, "new"), this.tsParsePropertyOrMethodSignature(node, !1));
    }
    this.tsParseModifiers({
      allowedModifiers: ["readonly"],
      disallowedModifiers: ["declare", "abstract", "private", "protected", "public", "static", "override"]
    }, node);
    const idx = this.tsTryParseIndexSignature(node);
    return idx || (super.parsePropertyName(node), !node.computed && node.key.type === "Identifier" && (node.key.name === "get" || node.key.name === "set") && this.tsTokenCanFollowModifier() && (node.kind = node.key.name, super.parsePropertyName(node), !this.match(tt.parenL) && !this.match(tt.lt) && this.unexpected(null, tt.parenL)), this.tsParsePropertyOrMethodSignature(node, !!node.readonly));
  }
  tsParseTypeLiteral() {
    const node = this.startNode();
    return node.members = this.tsParseObjectTypeMembers(), this.finishNode(node, "TSTypeLiteral");
  }
  tsParseObjectTypeMembers() {
    this.expect(tt.braceL);
    const members = this.tsParseList("TypeMembers", this.tsParseTypeMember.bind(this));
    return this.expect(tt.braceR), members;
  }
  tsIsStartOfMappedType() {
    return this.next(), this.eat(tt.plusMin) ? this.isContextual(tt._readonly) : (this.isContextual(tt._readonly) && this.next(), !this.match(tt.bracketL) || (this.next(), !this.tsIsIdentifier()) ? !1 : (this.next(), this.match(tt._in)));
  }
  tsParseMappedType() {
    const node = this.startNode();
    this.expect(tt.braceL), this.match(tt.plusMin) ? (node.readonly = this.state.value, this.next(), this.expectContextual(tt._readonly)) : this.eatContextual(tt._readonly) && (node.readonly = !0), this.expect(tt.bracketL);
    {
      const typeParameter = this.startNode();
      typeParameter.name = this.tsParseTypeParameterName(), typeParameter.constraint = this.tsExpectThenParseType(tt._in), node.typeParameter = this.finishNode(typeParameter, "TSTypeParameter");
    }
    return node.nameType = this.eatContextual(tt._as) ? this.tsParseType() : null, this.expect(tt.bracketR), this.match(tt.plusMin) ? (node.optional = this.state.value, this.next(), this.expect(tt.question)) : this.eat(tt.question) && (node.optional = !0), node.typeAnnotation = this.tsTryParseType(), this.semicolon(), this.expect(tt.braceR), this.finishNode(node, "TSMappedType");
  }
  tsParseTupleType() {
    const node = this.startNode();
    node.elementTypes = this.tsParseBracketedList("TupleElementTypes", this.tsParseTupleElementType.bind(this), !0, !1);
    let seenOptionalElement = !1;
    return node.elementTypes.forEach((elementNode) => {
      const {
        type
      } = elementNode;
      seenOptionalElement && type !== "TSRestType" && type !== "TSOptionalType" && !(type === "TSNamedTupleMember" && elementNode.optional) && this.raise(TSErrors.OptionalTypeBeforeRequired, elementNode), seenOptionalElement ||= type === "TSNamedTupleMember" && elementNode.optional || type === "TSOptionalType";
    }), this.finishNode(node, "TSTupleType");
  }
  tsParseTupleElementType() {
    const restStartLoc = this.state.startLoc, rest = this.eat(tt.ellipsis), {
      startLoc
    } = this.state;
    let labeled, label, optional, type;
    const chAfterWord = tokenIsKeywordOrIdentifier(this.state.type) ? this.lookaheadCharCode() : null;
    if (chAfterWord === 58)
      labeled = !0, optional = !1, label = this.parseIdentifier(!0), this.expect(tt.colon), type = this.tsParseType();
    else if (chAfterWord === 63) {
      optional = !0;
      const wordName = this.state.value, typeOrLabel = this.tsParseNonArrayType();
      this.lookaheadCharCode() === 58 ? (labeled = !0, label = this.createIdentifier(this.startNodeAt(startLoc), wordName), this.expect(tt.question), this.expect(tt.colon), type = this.tsParseType()) : (labeled = !1, type = typeOrLabel, this.expect(tt.question));
    } else
      type = this.tsParseType(), optional = this.eat(tt.question), labeled = this.eat(tt.colon);
    if (labeled) {
      let labeledNode;
      label ? (labeledNode = this.startNodeAt(startLoc), labeledNode.optional = optional, labeledNode.label = label, labeledNode.elementType = type, this.eat(tt.question) && (labeledNode.optional = !0, this.raise(TSErrors.TupleOptionalAfterType, this.state.lastTokStartLoc))) : (labeledNode = this.startNodeAt(startLoc), labeledNode.optional = optional, this.raise(TSErrors.InvalidTupleMemberLabel, type), labeledNode.label = type, labeledNode.elementType = this.tsParseType()), type = this.finishNode(labeledNode, "TSNamedTupleMember");
    } else if (optional) {
      const optionalTypeNode = this.startNodeAt(startLoc);
      optionalTypeNode.typeAnnotation = type, type = this.finishNode(optionalTypeNode, "TSOptionalType");
    }
    if (rest) {
      const restNode = this.startNodeAt(restStartLoc);
      restNode.typeAnnotation = type, type = this.finishNode(restNode, "TSRestType");
    }
    return type;
  }
  tsParseParenthesizedType() {
    const node = this.startNode();
    return this.expect(tt.parenL), node.typeAnnotation = this.tsParseType(), this.expect(tt.parenR), this.finishNode(node, "TSParenthesizedType");
  }
  tsParseFunctionOrConstructorType(type, abstract) {
    const node = this.startNode();
    return type === "TSConstructorType" && (node.abstract = !!abstract, abstract && this.next(), this.next()), this.tsInAllowConditionalTypesContext(() => this.tsFillSignature(tt.arrow, node)), this.finishNode(node, type);
  }
  tsParseLiteralTypeNode() {
    const node = this.startNode();
    switch (this.state.type) {
      case tt.num:
      case tt.bigint:
      case tt.string:
      case tt._true:
      case tt._false:
        node.literal = super.parseExprAtom();
        break;
      default:
        this.unexpected();
    }
    return this.finishNode(node, "TSLiteralType");
  }
  tsParseTemplateLiteralType() {
    {
      const node = this.startNode();
      return node.literal = super.parseTemplate(!1), this.finishNode(node, "TSLiteralType");
    }
  }
  parseTemplateSubstitution() {
    return this.state.inType ? this.tsParseType() : super.parseTemplateSubstitution();
  }
  tsParseThisTypeOrThisTypePredicate() {
    const thisKeyword = this.tsParseThisTypeNode();
    return this.isContextual(tt._is) && !this.hasPrecedingLineBreak() ? this.tsParseThisTypePredicate(thisKeyword) : thisKeyword;
  }
  tsParseNonArrayType() {
    switch (this.state.type) {
      case tt.string:
      case tt.num:
      case tt.bigint:
      case tt._true:
      case tt._false:
        return this.tsParseLiteralTypeNode();
      case tt.plusMin:
        if (this.state.value === "-") {
          const node = this.startNode(), nextToken = this.lookahead();
          return nextToken.type !== tt.num && nextToken.type !== tt.bigint && this.unexpected(), node.literal = this.parseMaybeUnary(), this.finishNode(node, "TSLiteralType");
        }
        break;
      case tt._this:
        return this.tsParseThisTypeOrThisTypePredicate();
      case tt._typeof:
        return this.tsParseTypeQuery();
      case tt._import:
        return this.tsParseImportType();
      case tt.braceL:
        return this.tsLookAhead(this.tsIsStartOfMappedType.bind(this)) ? this.tsParseMappedType() : this.tsParseTypeLiteral();
      case tt.bracketL:
        return this.tsParseTupleType();
      case tt.parenL:
        return this.tsParseParenthesizedType();
      case tt.templateNonTail:
      case tt.templateTail:
        return this.tsParseTemplateLiteralType();
      default: {
        const {
          type
        } = this.state;
        if (tokenIsIdentifier(type) || type === tt._void || type === tt._null) {
          const nodeType = type === tt._void ? "TSVoidKeyword" : type === tt._null ? "TSNullKeyword" : keywordTypeFromName(this.state.value);
          if (nodeType !== void 0 && this.lookaheadCharCode() !== 46) {
            const node = this.startNode();
            return this.next(), this.finishNode(node, nodeType);
          }
          return this.tsParseTypeReference();
        }
      }
    }
    throw this.unexpected();
  }
  tsParseArrayTypeOrHigher() {
    const {
      startLoc
    } = this.state;
    let type = this.tsParseNonArrayType();
    for (; !this.hasPrecedingLineBreak() && this.eat(tt.bracketL); )
      if (this.match(tt.bracketR)) {
        const node = this.startNodeAt(startLoc);
        node.elementType = type, this.expect(tt.bracketR), type = this.finishNode(node, "TSArrayType");
      } else {
        const node = this.startNodeAt(startLoc);
        node.objectType = type, node.indexType = this.tsParseType(), this.expect(tt.bracketR), type = this.finishNode(node, "TSIndexedAccessType");
      }
    return type;
  }
  tsParseTypeOperator() {
    const node = this.startNode(), operator = this.state.value;
    return this.next(), node.operator = operator, node.typeAnnotation = this.tsParseTypeOperatorOrHigher(), operator === "readonly" && this.tsCheckTypeAnnotationForReadOnly(node), this.finishNode(node, "TSTypeOperator");
  }
  tsCheckTypeAnnotationForReadOnly(node) {
    switch (node.typeAnnotation.type) {
      case "TSTupleType":
      case "TSArrayType":
        return;
      default:
        this.raise(TSErrors.UnexpectedReadonly, node);
    }
  }
  tsParseInferType() {
    const node = this.startNode();
    this.expectContextual(tt._infer);
    const typeParameter = this.startNode();
    return typeParameter.name = this.tsParseTypeParameterName(), typeParameter.constraint = this.tsTryParse(() => this.tsParseConstraintForInferType()), node.typeParameter = this.finishNode(typeParameter, "TSTypeParameter"), this.finishNode(node, "TSInferType");
  }
  tsParseConstraintForInferType() {
    if (this.eat(tt._extends)) {
      const constraint = this.tsInDisallowConditionalTypesContext(() => this.tsParseType());
      if (this.state.inDisallowConditionalTypesContext || !this.match(tt.question))
        return constraint;
    }
  }
  tsParseTypeOperatorOrHigher() {
    return tokenIsTSTypeOperator(this.state.type) && !this.state.containsEsc ? this.tsParseTypeOperator() : this.isContextual(tt._infer) ? this.tsParseInferType() : this.tsInAllowConditionalTypesContext(() => this.tsParseArrayTypeOrHigher());
  }
  tsParseUnionOrIntersectionType(kind, parseConstituentType, operator) {
    const node = this.startNode(), hasLeadingOperator = this.eat(operator), types = [];
    do
      types.push(parseConstituentType());
    while (this.eat(operator));
    return types.length === 1 && !hasLeadingOperator ? types[0] : (node.types = types, this.finishNode(node, kind));
  }
  tsParseIntersectionTypeOrHigher() {
    return this.tsParseUnionOrIntersectionType("TSIntersectionType", this.tsParseTypeOperatorOrHigher.bind(this), tt.bitwiseAND);
  }
  tsParseUnionTypeOrHigher() {
    return this.tsParseUnionOrIntersectionType("TSUnionType", this.tsParseIntersectionTypeOrHigher.bind(this), tt.bitwiseOR);
  }
  tsIsStartOfFunctionType() {
    return this.match(tt.lt) ? !0 : this.match(tt.parenL) && this.tsLookAhead(this.tsIsUnambiguouslyStartOfFunctionType.bind(this));
  }
  tsSkipParameterStart() {
    if (tokenIsIdentifier(this.state.type) || this.match(tt._this))
      return this.next(), !0;
    if (this.match(tt.braceL)) {
      const {
        errors
      } = this.state, previousErrorCount = errors.length;
      try {
        return this.parseObjectLike(tt.braceR, !0), errors.length === previousErrorCount;
      } catch {
        return !1;
      }
    }
    if (this.match(tt.bracketL)) {
      this.next();
      const {
        errors
      } = this.state, previousErrorCount = errors.length;
      try {
        return super.parseBindingList(tt.bracketR, 93, ParseBindingListFlags.ALLOW_EMPTY), errors.length === previousErrorCount;
      } catch {
        return !1;
      }
    }
    return !1;
  }
  tsIsUnambiguouslyStartOfFunctionType() {
    return this.next(), !!(this.match(tt.parenR) || this.match(tt.ellipsis) || this.tsSkipParameterStart() && (this.match(tt.colon) || this.match(tt.comma) || this.match(tt.question) || this.match(tt.eq) || this.match(tt.parenR) && (this.next(), this.match(tt.arrow))));
  }
  tsParseTypeOrTypePredicateAnnotation(returnToken) {
    return this.tsInType(() => {
      const t = this.startNode();
      this.expect(returnToken);
      const node = this.startNode(), asserts = !!this.tsTryParse(this.tsParseTypePredicateAsserts.bind(this));
      if (asserts && this.match(tt._this)) {
        let thisTypePredicate = this.tsParseThisTypeOrThisTypePredicate();
        return thisTypePredicate.type === "TSThisType" ? (node.parameterName = thisTypePredicate, node.asserts = !0, node.typeAnnotation = null, thisTypePredicate = this.finishNode(node, "TSTypePredicate")) : (this.resetStartLocationFromNode(thisTypePredicate, node), thisTypePredicate.asserts = !0), t.typeAnnotation = thisTypePredicate, this.finishNode(t, "TSTypeAnnotation");
      }
      const typePredicateVariable = this.tsIsIdentifier() && this.tsTryParse(this.tsParseTypePredicatePrefix.bind(this));
      if (!typePredicateVariable)
        return asserts ? (node.parameterName = this.parseIdentifier(), node.asserts = asserts, node.typeAnnotation = null, t.typeAnnotation = this.finishNode(node, "TSTypePredicate"), this.finishNode(t, "TSTypeAnnotation")) : this.tsParseTypeAnnotation(!1, t);
      const type = this.tsParseTypeAnnotation(!1);
      return node.parameterName = typePredicateVariable, node.typeAnnotation = type, node.asserts = asserts, t.typeAnnotation = this.finishNode(node, "TSTypePredicate"), this.finishNode(t, "TSTypeAnnotation");
    });
  }
  tsTryParseTypeOrTypePredicateAnnotation() {
    if (this.match(tt.colon))
      return this.tsParseTypeOrTypePredicateAnnotation(tt.colon);
  }
  tsTryParseTypeAnnotation() {
    if (this.match(tt.colon))
      return this.tsParseTypeAnnotation();
  }
  tsTryParseType() {
    return this.tsEatThenParseType(tt.colon);
  }
  tsParseTypePredicatePrefix() {
    const id = this.parseIdentifier();
    if (this.isContextual(tt._is) && !this.hasPrecedingLineBreak())
      return this.next(), id;
  }
  tsParseTypePredicateAsserts() {
    if (this.state.type !== tt._asserts)
      return !1;
    const containsEsc = this.state.containsEsc;
    return this.next(), !tokenIsIdentifier(this.state.type) && !this.match(tt._this) ? !1 : (containsEsc && this.raise(Errors.InvalidEscapedReservedWord, this.state.lastTokStartLoc, {
      reservedWord: "asserts"
    }), !0);
  }
  tsParseTypeAnnotation(eatColon = !0, t = this.startNode()) {
    return this.tsInType(() => {
      eatColon && this.expect(tt.colon), t.typeAnnotation = this.tsParseType();
    }), this.finishNode(t, "TSTypeAnnotation");
  }
  tsParseType() {
    assert(this.state.inType);
    const type = this.tsParseNonConditionalType();
    if (this.state.inDisallowConditionalTypesContext || this.hasPrecedingLineBreak() || !this.eat(tt._extends))
      return type;
    const node = this.startNodeAtNode(type);
    return node.checkType = type, node.extendsType = this.tsInDisallowConditionalTypesContext(() => this.tsParseNonConditionalType()), this.expect(tt.question), node.trueType = this.tsInAllowConditionalTypesContext(() => this.tsParseType()), this.expect(tt.colon), node.falseType = this.tsInAllowConditionalTypesContext(() => this.tsParseType()), this.finishNode(node, "TSConditionalType");
  }
  isAbstractConstructorSignature() {
    return this.isContextual(tt._abstract) && this.isLookaheadContextual("new");
  }
  tsParseNonConditionalType() {
    return this.tsIsStartOfFunctionType() ? this.tsParseFunctionOrConstructorType("TSFunctionType") : this.match(tt._new) ? this.tsParseFunctionOrConstructorType("TSConstructorType") : this.isAbstractConstructorSignature() ? this.tsParseFunctionOrConstructorType("TSConstructorType", !0) : this.tsParseUnionTypeOrHigher();
  }
  tsParseTypeAssertion() {
    this.getPluginOption("typescript", "disallowAmbiguousJSXLike") && this.raise(TSErrors.ReservedTypeAssertion, this.state.startLoc);
    const node = this.startNode();
    return node.typeAnnotation = this.tsInType(() => (this.next(), this.match(tt._const) ? this.tsParseTypeReference() : this.tsParseType())), this.expect(tt.gt), node.expression = this.parseMaybeUnary(), this.finishNode(node, "TSTypeAssertion");
  }
  tsParseHeritageClause(token) {
    const originalStartLoc = this.state.startLoc, delimitedList = this.tsParseDelimitedList("HeritageClauseElement", () => {
      {
        const node = this.startNode();
        return node.expression = this.tsParseEntityName(tsParseEntityNameFlags.ALLOW_RESERVED_WORDS | tsParseEntityNameFlags.LEADING_THIS_AS_IDENTIFIER), this.match(tt.lt) && (node.typeParameters = this.tsParseTypeArguments()), this.finishNode(node, "TSExpressionWithTypeArguments");
      }
    });
    return delimitedList.length || this.raise(TSErrors.EmptyHeritageClauseType, originalStartLoc, {
      token
    }), delimitedList;
  }
  tsParseInterfaceDeclaration(node, properties = {}) {
    if (this.hasFollowingLineBreak()) return null;
    this.expectContextual(tt._interface), properties.declare && (node.declare = !0), tokenIsIdentifier(this.state.type) ? (node.id = this.parseIdentifier(), this.checkIdentifier(node.id, BindingFlag.TYPE_TS_INTERFACE)) : (node.id = null, this.raise(TSErrors.MissingInterfaceName, this.state.startLoc)), node.typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutConstModifiers), this.eat(tt._extends) && (node.extends = this.tsParseHeritageClause("extends"));
    const body = this.startNode();
    return body.body = this.tsInType(this.tsParseObjectTypeMembers.bind(this)), node.body = this.finishNode(body, "TSInterfaceBody"), this.finishNode(node, "TSInterfaceDeclaration");
  }
  tsParseTypeAliasDeclaration(node) {
    return node.id = this.parseIdentifier(), this.checkIdentifier(node.id, BindingFlag.TYPE_TS_TYPE), node.typeAnnotation = this.tsInType(() => {
      if (node.typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutModifiers), this.expect(tt.eq), this.isContextual(tt._intrinsic) && this.lookaheadCharCode() !== 46) {
        const node2 = this.startNode();
        return this.next(), this.finishNode(node2, "TSIntrinsicKeyword");
      }
      return this.tsParseType();
    }), this.semicolon(), this.finishNode(node, "TSTypeAliasDeclaration");
  }
  tsInTopLevelContext(cb) {
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
  tsInType(cb) {
    const oldInType = this.state.inType;
    this.state.inType = !0;
    try {
      return cb();
    } finally {
      this.state.inType = oldInType;
    }
  }
  tsInDisallowConditionalTypesContext(cb) {
    const oldInDisallowConditionalTypesContext = this.state.inDisallowConditionalTypesContext;
    this.state.inDisallowConditionalTypesContext = !0;
    try {
      return cb();
    } finally {
      this.state.inDisallowConditionalTypesContext = oldInDisallowConditionalTypesContext;
    }
  }
  tsInAllowConditionalTypesContext(cb) {
    const oldInDisallowConditionalTypesContext = this.state.inDisallowConditionalTypesContext;
    this.state.inDisallowConditionalTypesContext = !1;
    try {
      return cb();
    } finally {
      this.state.inDisallowConditionalTypesContext = oldInDisallowConditionalTypesContext;
    }
  }
  tsEatThenParseType(token) {
    if (this.match(token))
      return this.tsNextThenParseType();
  }
  tsExpectThenParseType(token) {
    return this.tsInType(() => (this.expect(token), this.tsParseType()));
  }
  tsNextThenParseType() {
    return this.tsInType(() => (this.next(), this.tsParseType()));
  }
  tsParseEnumMember() {
    const node = this.startNode();
    return node.id = this.match(tt.string) ? super.parseStringLiteral(this.state.value) : this.parseIdentifier(!0), this.eat(tt.eq) && (node.initializer = super.parseMaybeAssignAllowIn()), this.finishNode(node, "TSEnumMember");
  }
  tsParseEnumDeclaration(node, properties = {}) {
    return properties.const && (node.const = !0), properties.declare && (node.declare = !0), this.expectContextual(tt._enum), node.id = this.parseIdentifier(), this.checkIdentifier(node.id, node.const ? BindingFlag.TYPE_TS_CONST_ENUM : BindingFlag.TYPE_TS_ENUM), this.expect(tt.braceL), node.members = this.tsParseDelimitedList("EnumMembers", this.tsParseEnumMember.bind(this)), this.expect(tt.braceR), this.finishNode(node, "TSEnumDeclaration");
  }
  tsParseEnumBody() {
    const node = this.startNode();
    return this.expect(tt.braceL), node.members = this.tsParseDelimitedList("EnumMembers", this.tsParseEnumMember.bind(this)), this.expect(tt.braceR), this.finishNode(node, "TSEnumBody");
  }
  tsParseModuleBlock() {
    const node = this.startNode();
    return this.scope.enter(ScopeFlag.OTHER), this.expect(tt.braceL), super.parseBlockOrModuleBlockBody(node.body = [], void 0, !0, tt.braceR), this.scope.exit(), this.finishNode(node, "TSModuleBlock");
  }
  tsParseModuleOrNamespaceDeclaration(node, nested = !1) {
    if (node.id = this.parseIdentifier(), nested || this.checkIdentifier(node.id, BindingFlag.TYPE_TS_NAMESPACE), this.eat(tt.dot)) {
      const inner = this.startNode();
      this.tsParseModuleOrNamespaceDeclaration(inner, !0), node.body = inner;
    } else
      this.scope.enter(ScopeFlag.TS_MODULE), this.prodParam.enter(ParamKind.PARAM), node.body = this.tsParseModuleBlock(), this.prodParam.exit(), this.scope.exit();
    return this.finishNode(node, "TSModuleDeclaration");
  }
  tsParseAmbientExternalModuleDeclaration(node) {
    return this.isContextual(tt._global) ? (node.kind = "global", node.global = !0, node.id = this.parseIdentifier()) : this.match(tt.string) ? (node.kind = "module", node.id = super.parseStringLiteral(this.state.value)) : this.unexpected(), this.match(tt.braceL) ? (this.scope.enter(ScopeFlag.TS_MODULE), this.prodParam.enter(ParamKind.PARAM), node.body = this.tsParseModuleBlock(), this.prodParam.exit(), this.scope.exit()) : this.semicolon(), this.finishNode(node, "TSModuleDeclaration");
  }
  tsParseImportEqualsDeclaration(node, maybeDefaultIdentifier, isExport) {
    node.isExport = isExport || !1, node.id = maybeDefaultIdentifier || this.parseIdentifier(), this.checkIdentifier(node.id, BindingFlag.TYPE_TS_VALUE_IMPORT), this.expect(tt.eq);
    const moduleReference = this.tsParseModuleReference();
    return node.importKind === "type" && moduleReference.type !== "TSExternalModuleReference" && this.raise(TSErrors.ImportAliasHasImportType, moduleReference), node.moduleReference = moduleReference, this.semicolon(), this.finishNode(node, "TSImportEqualsDeclaration");
  }
  tsIsExternalModuleReference() {
    return this.isContextual(tt._require) && this.lookaheadCharCode() === 40;
  }
  tsParseModuleReference() {
    return this.tsIsExternalModuleReference() ? this.tsParseExternalModuleReference() : this.tsParseEntityName(tsParseEntityNameFlags.NONE);
  }
  tsParseExternalModuleReference() {
    const node = this.startNode();
    return this.expectContextual(tt._require), this.expect(tt.parenL), this.match(tt.string) || this.unexpected(), node.expression = super.parseExprAtom(), this.expect(tt.parenR), this.sawUnambiguousESM = !0, this.finishNode(node, "TSExternalModuleReference");
  }
  tsLookAhead(f) {
    const state = this.state.clone(), res = f();
    return this.state = state, res;
  }
  tsTryParseAndCatch(f) {
    const result = this.tryParse((abort) => f() || abort());
    if (!(result.aborted || !result.node))
      return result.error && (this.state = result.failState), result.node;
  }
  tsTryParse(f) {
    const state = this.state.clone(), result = f();
    if (result !== void 0 && result !== !1)
      return result;
    this.state = state;
  }
  tsTryParseDeclare(node) {
    if (this.isLineTerminator())
      return;
    const startType = this.state.type;
    return this.tsInAmbientContext(() => {
      switch (startType) {
        case tt._function:
          return node.declare = !0, super.parseFunctionStatement(node, !1, !1);
        case tt._class:
          return node.declare = !0, this.parseClass(node, !0, !1);
        case tt._enum:
          return this.tsParseEnumDeclaration(node, {
            declare: !0
          });
        case tt._global:
          return this.tsParseAmbientExternalModuleDeclaration(node);
        case tt._let:
          if (this.state.containsEsc)
            return;
        case tt._const:
        case tt._var:
          return !this.match(tt._const) || !this.isLookaheadContextual("enum") ? (node.declare = !0, this.parseVarStatement(node, this.state.value, !0)) : (this.expect(tt._const), this.tsParseEnumDeclaration(node, {
            const: !0,
            declare: !0
          }));
        case tt._using:
          if (this.isUsing())
            return this.raise(TSErrors.InvalidModifierOnUsingDeclaration, this.state.startLoc, "declare"), node.declare = !0, this.parseVarStatement(node, "using", !0);
          break;
        case tt._await:
          if (this.isAwaitUsing())
            return this.raise(TSErrors.InvalidModifierOnAwaitUsingDeclaration, this.state.startLoc, "declare"), node.declare = !0, this.next(), this.parseVarStatement(node, "await using", !0);
          break;
        case tt._interface: {
          const result = this.tsParseInterfaceDeclaration(node, {
            declare: !0
          });
          if (result) return result;
        }
        default:
          if (tokenIsIdentifier(startType))
            return this.tsParseDeclaration(node, this.state.type, !0, null);
      }
    });
  }
  tsTryParseExportDeclaration() {
    return this.tsParseDeclaration(this.startNode(), this.state.type, !0, null);
  }
  tsParseDeclaration(node, type, next, decorators) {
    switch (type) {
      case tt._abstract:
        if (this.tsCheckLineTerminator(next) && (this.match(tt._class) || tokenIsIdentifier(this.state.type)))
          return this.tsParseAbstractDeclaration(node, decorators);
        break;
      case tt._module:
        if (this.tsCheckLineTerminator(next)) {
          if (this.match(tt.string))
            return this.tsParseAmbientExternalModuleDeclaration(node);
          if (tokenIsIdentifier(this.state.type))
            return node.kind = "module", this.tsParseModuleOrNamespaceDeclaration(node);
        }
        break;
      case tt._namespace:
        if (this.tsCheckLineTerminator(next) && tokenIsIdentifier(this.state.type))
          return node.kind = "namespace", this.tsParseModuleOrNamespaceDeclaration(node);
        break;
      case tt._type:
        if (this.tsCheckLineTerminator(next) && tokenIsIdentifier(this.state.type))
          return this.tsParseTypeAliasDeclaration(node);
        break;
    }
  }
  tsCheckLineTerminator(next) {
    return next ? this.hasFollowingLineBreak() ? !1 : (this.next(), !0) : !this.isLineTerminator();
  }
  tsTryParseGenericAsyncArrowFunction(startLoc) {
    if (!this.match(tt.lt)) return;
    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    this.state.maybeInArrowParameters = !0;
    const res = this.tsTryParseAndCatch(() => {
      const node = this.startNodeAt(startLoc);
      return node.typeParameters = this.tsParseTypeParameters(this.tsParseConstModifier), super.parseFunctionParams(node), node.returnType = this.tsTryParseTypeOrTypePredicateAnnotation(), this.expect(tt.arrow), node;
    });
    if (this.state.maybeInArrowParameters = oldMaybeInArrowParameters, !!res)
      return super.parseArrowExpression(res, null, !0);
  }
  tsParseTypeArgumentsInExpression() {
    if (this.reScan_lt() === tt.lt)
      return this.tsParseTypeArguments();
  }
  tsParseTypeArguments() {
    const node = this.startNode();
    return node.params = this.tsInType(() => this.tsInTopLevelContext(() => (this.expect(tt.lt), this.tsParseDelimitedList("TypeParametersOrArguments", this.tsParseType.bind(this))))), node.params.length === 0 ? this.raise(TSErrors.EmptyTypeArguments, node) : !this.state.inType && this.curContext() === tc.brace && this.reScan_lt_gt(), this.expect(tt.gt), this.finishNode(node, "TSTypeParameterInstantiation");
  }
  tsIsDeclarationStart() {
    return tokenIsTSDeclarationStart(this.state.type);
  }
  isExportDefaultSpecifier() {
    return this.tsIsDeclarationStart() ? !1 : super.isExportDefaultSpecifier();
  }
  parseBindingElement(flags, decorators) {
    const startLoc = decorators.length ? decorators[0].loc.start : this.state.startLoc, modified = {};
    this.tsParseModifiers({
      allowedModifiers: ["public", "private", "protected", "override", "readonly"]
    }, modified);
    const accessibility = modified.accessibility, override = modified.override, readonly = modified.readonly;
    !(flags & ParseBindingListFlags.IS_CONSTRUCTOR_PARAMS) && (accessibility || readonly || override) && this.raise(TSErrors.UnexpectedParameterModifier, startLoc);
    const left = this.parseMaybeDefault();
    flags & ParseBindingListFlags.IS_FUNCTION_PARAMS && this.parseFunctionParamType(left);
    const elt = this.parseMaybeDefault(left.loc.start, left);
    if (accessibility || readonly || override) {
      const pp = this.startNodeAt(startLoc);
      return decorators.length && (pp.decorators = decorators), accessibility && (pp.accessibility = accessibility), readonly && (pp.readonly = readonly), override && (pp.override = override), elt.type !== "Identifier" && elt.type !== "AssignmentPattern" && this.raise(TSErrors.UnsupportedParameterPropertyKind, pp), pp.parameter = elt, this.finishNode(pp, "TSParameterProperty");
    }
    return decorators.length && (left.decorators = decorators), elt;
  }
  isSimpleParameter(node) {
    return node.type === "TSParameterProperty" && super.isSimpleParameter(node.parameter) || super.isSimpleParameter(node);
  }
  tsDisallowOptionalPattern(node) {
    for (const param of node.params)
      param.type !== "Identifier" && param.optional && !this.state.isAmbientContext && this.raise(TSErrors.PatternIsOptional, param);
  }
  setArrowFunctionParameters(node, params, trailingCommaLoc) {
    super.setArrowFunctionParameters(node, params, trailingCommaLoc), this.tsDisallowOptionalPattern(node);
  }
  parseFunctionBodyAndFinish(node, type, isMethod = !1) {
    this.match(tt.colon) && (node.returnType = this.tsParseTypeOrTypePredicateAnnotation(tt.colon));
    const bodilessType = type === "FunctionDeclaration" ? "TSDeclareFunction" : type === "ClassMethod" || type === "ClassPrivateMethod" ? "TSDeclareMethod" : void 0;
    return bodilessType && !this.match(tt.braceL) && this.isLineTerminator() ? this.finishNode(node, bodilessType) : bodilessType === "TSDeclareFunction" && this.state.isAmbientContext && (this.raise(TSErrors.DeclareFunctionHasImplementation, node), node.declare) ? super.parseFunctionBodyAndFinish(node, bodilessType, isMethod) : (this.tsDisallowOptionalPattern(node), super.parseFunctionBodyAndFinish(node, type, isMethod));
  }
  registerFunctionStatementId(node) {
    !node.body && node.id ? this.checkIdentifier(node.id, BindingFlag.TYPE_TS_AMBIENT) : super.registerFunctionStatementId(node);
  }
  tsCheckForInvalidTypeCasts(items) {
    items.forEach((node) => {
      node?.type === "TSTypeCastExpression" && this.raise(TSErrors.UnexpectedTypeAnnotation, node.typeAnnotation);
    });
  }
  toReferencedList(exprList, isInParens) {
    return this.tsCheckForInvalidTypeCasts(exprList), exprList;
  }
  parseArrayLike(close, isTuple, refExpressionErrors) {
    const node = super.parseArrayLike(close, isTuple, refExpressionErrors);
    return node.type === "ArrayExpression" && this.tsCheckForInvalidTypeCasts(node.elements), node;
  }
  parseSubscript(base, startLoc, noCalls, state) {
    if (!this.hasPrecedingLineBreak() && this.match(tt.bang)) {
      this.state.canStartJSXElement = !1, this.next();
      const nonNullExpression = this.startNodeAt(startLoc);
      return nonNullExpression.expression = base, this.finishNode(nonNullExpression, "TSNonNullExpression");
    }
    let isOptionalCall = !1;
    if (this.match(tt.questionDot) && this.lookaheadCharCode() === 60) {
      if (noCalls)
        return state.stop = !0, base;
      state.optionalChainMember = isOptionalCall = !0, this.next();
    }
    if (this.match(tt.lt) || this.match(tt.bitShiftL)) {
      let missingParenErrorLoc;
      const result = this.tsTryParseAndCatch(() => {
        if (!noCalls && this.atPossibleAsyncArrow(base)) {
          const asyncArrowFn = this.tsTryParseGenericAsyncArrowFunction(startLoc);
          if (asyncArrowFn)
            return state.stop = !0, asyncArrowFn;
        }
        const typeArguments = this.tsParseTypeArgumentsInExpression();
        if (!typeArguments) return;
        if (isOptionalCall && !this.match(tt.parenL)) {
          missingParenErrorLoc = this.state.curPosition();
          return;
        }
        if (tokenIsTemplate(this.state.type)) {
          const result2 = super.parseTaggedTemplateExpression(base, startLoc, state);
          return result2.typeParameters = typeArguments, result2;
        }
        if (!noCalls && this.eat(tt.parenL)) {
          const node2 = this.startNodeAt(startLoc);
          return node2.callee = base, node2.arguments = this.parseCallExpressionArguments(), this.tsCheckForInvalidTypeCasts(node2.arguments), node2.typeParameters = typeArguments, state.optionalChainMember && (node2.optional = isOptionalCall), this.finishCallExpression(node2, state.optionalChainMember);
        }
        const tokenType = this.state.type;
        if (tokenType === tt.gt || tokenType === tt.bitShiftR || tokenType !== tt.parenL && tokenType !== tt._as && tokenType !== tt._satisfies && tokenCanStartExpression(tokenType) && !this.hasPrecedingLineBreak())
          return;
        const node = this.startNodeAt(startLoc);
        return node.expression = base, node.typeParameters = typeArguments, this.finishNode(node, "TSInstantiationExpression");
      });
      if (missingParenErrorLoc && this.unexpected(missingParenErrorLoc, tt.parenL), result)
        return result.type === "TSInstantiationExpression" && ((this.match(tt.dot) || this.match(tt.questionDot) && this.lookaheadCharCode() !== 40) && this.raise(TSErrors.InvalidPropertyAccessAfterInstantiationExpression, this.state.startLoc), !this.match(tt.dot) && !this.match(tt.questionDot) && (result.expression = super.stopParseSubscript(base, state))), result;
    }
    return super.parseSubscript(base, startLoc, noCalls, state);
  }
  parseNewCallee(node) {
    super.parseNewCallee(node);
    const {
      callee
    } = node;
    callee.type === "TSInstantiationExpression" && !callee.extra?.parenthesized && (node.typeParameters = callee.typeParameters, node.callee = callee.expression);
  }
  parseExprOp(left, leftStartLoc, minPrec) {
    let isSatisfies;
    if (tokenOperatorPrecedence(tt._in) > minPrec && !this.hasPrecedingLineBreak() && (this.isContextual(tt._as) || (isSatisfies = this.isContextual(tt._satisfies)))) {
      const node = this.startNodeAt(leftStartLoc);
      return node.expression = left, node.typeAnnotation = this.tsInType(() => (this.next(), this.match(tt._const) ? (isSatisfies && this.raise(Errors.UnexpectedKeyword, this.state.startLoc, {
        keyword: "const"
      }), this.tsParseTypeReference()) : this.tsParseType())), this.finishNode(node, isSatisfies ? "TSSatisfiesExpression" : "TSAsExpression"), this.reScan_lt_gt(), this.parseExprOp(node, leftStartLoc, minPrec);
    }
    return super.parseExprOp(left, leftStartLoc, minPrec);
  }
  checkReservedWord(word, startLoc, checkKeywords, isBinding) {
    this.state.isAmbientContext || super.checkReservedWord(word, startLoc, checkKeywords, isBinding);
  }
  checkImportReflection(node) {
    super.checkImportReflection(node), node.module && node.importKind !== "value" && this.raise(TSErrors.ImportReflectionHasImportType, node.specifiers[0].loc.start);
  }
  checkDuplicateExports() {
  }
  isPotentialImportPhase(isExport) {
    if (super.isPotentialImportPhase(isExport)) return !0;
    if (this.isContextual(tt._type)) {
      const ch = this.lookaheadCharCode();
      return isExport ? ch === 123 || ch === 42 : ch !== 61;
    }
    return !isExport && this.isContextual(tt._typeof);
  }
  applyImportPhase(node, isExport, phase, loc) {
    super.applyImportPhase(node, isExport, phase, loc), isExport ? node.exportKind = phase === "type" ? "type" : "value" : node.importKind = phase === "type" || phase === "typeof" ? phase : "value";
  }
  parseImport(node) {
    if (this.match(tt.string))
      return node.importKind = "value", super.parseImport(node);
    let importNode;
    if (tokenIsIdentifier(this.state.type) && this.lookaheadCharCode() === 61)
      return node.importKind = "value", this.tsParseImportEqualsDeclaration(node);
    if (this.isContextual(tt._type)) {
      const maybeDefaultIdentifier = this.parseMaybeImportPhase(node, !1);
      if (this.lookaheadCharCode() === 61)
        return this.tsParseImportEqualsDeclaration(node, maybeDefaultIdentifier);
      importNode = super.parseImportSpecifiersAndAfter(node, maybeDefaultIdentifier);
    } else
      importNode = super.parseImport(node);
    return importNode.importKind === "type" && importNode.specifiers.length > 1 && importNode.specifiers[0].type === "ImportDefaultSpecifier" && this.raise(TSErrors.TypeImportCannotSpecifyDefaultAndNamed, importNode), importNode;
  }
  parseExport(node, decorators) {
    if (this.match(tt._import)) {
      const nodeImportEquals = node;
      this.next();
      let maybeDefaultIdentifier = null;
      return this.isContextual(tt._type) && this.isPotentialImportPhase(!1) ? maybeDefaultIdentifier = this.parseMaybeImportPhase(nodeImportEquals, !1) : nodeImportEquals.importKind = "value", this.tsParseImportEqualsDeclaration(nodeImportEquals, maybeDefaultIdentifier, !0);
    } else if (this.eat(tt.eq)) {
      const assign = node;
      return assign.expression = super.parseExpression(), this.semicolon(), this.sawUnambiguousESM = !0, this.finishNode(assign, "TSExportAssignment");
    } else if (this.eatContextual(tt._as)) {
      const decl = node;
      return this.expectContextual(tt._namespace), decl.id = this.parseIdentifier(), this.semicolon(), this.finishNode(decl, "TSNamespaceExportDeclaration");
    } else
      return super.parseExport(node, decorators);
  }
  isAbstractClass() {
    return this.isContextual(tt._abstract) && this.isLookaheadContextual("class");
  }
  parseExportDefaultExpression() {
    if (this.isAbstractClass()) {
      const cls = this.startNode();
      return this.next(), cls.abstract = !0, this.parseClass(cls, !0, !0);
    }
    if (this.match(tt._interface)) {
      const result = this.tsParseInterfaceDeclaration(this.startNode());
      if (result) return result;
    }
    return super.parseExportDefaultExpression();
  }
  parseVarStatement(node, kind, allowMissingInitializer = !1) {
    const {
      isAmbientContext
    } = this.state, declaration = super.parseVarStatement(node, kind, allowMissingInitializer || isAmbientContext);
    if (!isAmbientContext) return declaration;
    if (!node.declare && (kind === "using" || kind === "await using"))
      return this.raiseOverwrite(TSErrors.UsingDeclarationInAmbientContext, node, kind), declaration;
    for (const {
      id,
      init
    } of declaration.declarations)
      init && (kind === "var" || kind === "let" || id.typeAnnotation ? this.raise(TSErrors.InitializerNotAllowedInAmbientContext, init) : isValidAmbientConstInitializer(init, this.hasPlugin("estree")) || this.raise(TSErrors.ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference, init));
    return declaration;
  }
  parseStatementContent(flags, decorators) {
    if (!this.state.containsEsc)
      switch (this.state.type) {
        case tt._const: {
          if (this.isLookaheadContextual("enum")) {
            const node = this.startNode();
            return this.expect(tt._const), this.tsParseEnumDeclaration(node, {
              const: !0
            });
          }
          break;
        }
        case tt._abstract:
        case tt._declare: {
          if (this.nextTokenIsIdentifierAndNotTSRelationalOperatorOnSameLine()) {
            const token = this.state.type, node = this.startNode();
            this.next();
            const declaration = token === tt._declare ? this.tsTryParseDeclare(node) : this.tsParseAbstractDeclaration(node, decorators);
            return declaration ? (token === tt._declare && (declaration.declare = !0), declaration) : (node.expression = this.createIdentifier(this.startNodeAt(node.loc.start), token === tt._declare ? "declare" : "abstract"), this.semicolon(!1), this.finishNode(node, "ExpressionStatement"));
          }
          break;
        }
        case tt._enum:
          return this.tsParseEnumDeclaration(this.startNode());
        case tt._global: {
          if (this.lookaheadCharCode() === 123) {
            const node = this.startNode();
            return this.tsParseAmbientExternalModuleDeclaration(node);
          }
          break;
        }
        case tt._interface: {
          const result = this.tsParseInterfaceDeclaration(this.startNode());
          if (result) return result;
          break;
        }
        case tt._module: {
          if (this.nextTokenIsIdentifierOrStringLiteralOnSameLine()) {
            const node = this.startNode();
            return this.next(), this.tsParseDeclaration(node, tt._module, !1, decorators);
          }
          break;
        }
        case tt._namespace: {
          if (this.nextTokenIsIdentifierOnSameLine()) {
            const node = this.startNode();
            return this.next(), this.tsParseDeclaration(node, tt._namespace, !1, decorators);
          }
          break;
        }
        case tt._type: {
          if (this.nextTokenIsIdentifierOnSameLine()) {
            const node = this.startNode();
            return this.next(), this.tsParseTypeAliasDeclaration(node);
          }
          break;
        }
      }
    return super.parseStatementContent(flags, decorators);
  }
  parseAccessModifier() {
    return this.tsParseModifier(["public", "protected", "private"]);
  }
  tsHasSomeModifiers(member, modifiers) {
    return modifiers.some((modifier) => tsIsAccessModifier(modifier) ? member.accessibility === modifier : !!member[modifier]);
  }
  tsIsStartOfStaticBlocks() {
    return this.isContextual(tt._static) && this.lookaheadCharCode() === 123;
  }
  parseClassMember(classBody, member, state) {
    const modifiers = ["declare", "private", "public", "protected", "override", "abstract", "readonly", "static"];
    this.tsParseModifiers({
      allowedModifiers: modifiers,
      disallowedModifiers: ["in", "out"],
      stopOnStartOfClassStaticBlock: !0,
      errorTemplate: TSErrors.InvalidModifierOnTypeParameterPositions
    }, member);
    const callParseClassMemberWithIsStatic = () => {
      this.tsIsStartOfStaticBlocks() ? (this.next(), this.next(), this.tsHasSomeModifiers(member, modifiers) && this.raise(TSErrors.StaticBlockCannotHaveModifier, this.state.curPosition()), super.parseClassStaticBlock(classBody, member)) : this.parseClassMemberWithIsStatic(classBody, member, state, !!member.static);
    };
    member.declare ? this.tsInAmbientContext(callParseClassMemberWithIsStatic) : callParseClassMemberWithIsStatic();
  }
  parseClassMemberWithIsStatic(classBody, member, state, isStatic) {
    const idx = this.tsTryParseIndexSignature(member);
    if (idx) {
      classBody.body.push(idx), member.abstract && this.raise(TSErrors.IndexSignatureHasAbstract, member), member.accessibility && this.raise(TSErrors.IndexSignatureHasAccessibility, member, {
        modifier: member.accessibility
      }), member.declare && this.raise(TSErrors.IndexSignatureHasDeclare, member), member.override && this.raise(TSErrors.IndexSignatureHasOverride, member);
      return;
    }
    !this.state.inAbstractClass && member.abstract && this.raise(TSErrors.NonAbstractClassHasAbstractMethod, member), member.override && (state.hadSuperClass || this.raise(TSErrors.OverrideNotInSubClass, member)), super.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
  }
  parsePostMemberNameModifiers(methodOrProp) {
    this.eat(tt.question) && (methodOrProp.optional = !0), methodOrProp.readonly && this.match(tt.parenL) && this.raise(TSErrors.ClassMethodHasReadonly, methodOrProp), methodOrProp.declare && this.match(tt.parenL) && this.raise(TSErrors.ClassMethodHasDeclare, methodOrProp);
  }
  shouldParseExportDeclaration() {
    return this.tsIsDeclarationStart() ? !0 : super.shouldParseExportDeclaration();
  }
  parseConditional(expr, startLoc, refExpressionErrors) {
    if (!this.match(tt.question)) return expr;
    if (this.state.maybeInArrowParameters) {
      const nextCh = this.lookaheadCharCode();
      if (nextCh === 44 || nextCh === 61 || nextCh === 58 || nextCh === 41)
        return this.setOptionalParametersError(refExpressionErrors), expr;
    }
    return super.parseConditional(expr, startLoc, refExpressionErrors);
  }
  parseParenItem(node, startLoc) {
    const newNode = super.parseParenItem(node, startLoc);
    if (this.eat(tt.question) && (newNode.optional = !0, this.resetEndLocation(node)), this.match(tt.colon)) {
      const typeCastNode = this.startNodeAt(startLoc);
      return typeCastNode.expression = node, typeCastNode.typeAnnotation = this.tsParseTypeAnnotation(), this.finishNode(typeCastNode, "TSTypeCastExpression");
    }
    return node;
  }
  parseExportDeclaration(node) {
    if (!this.state.isAmbientContext && this.isContextual(tt._declare))
      return this.tsInAmbientContext(() => this.parseExportDeclaration(node));
    const startLoc = this.state.startLoc, isDeclare = this.eatContextual(tt._declare);
    if (isDeclare && (this.isContextual(tt._declare) || !this.shouldParseExportDeclaration()))
      throw this.raise(TSErrors.ExpectedAmbientAfterExportDeclare, this.state.startLoc);
    const declaration = tokenIsIdentifier(this.state.type) && this.tsTryParseExportDeclaration() || super.parseExportDeclaration(node);
    return declaration ? ((declaration.type === "TSInterfaceDeclaration" || declaration.type === "TSTypeAliasDeclaration" || isDeclare) && (node.exportKind = "type"), isDeclare && declaration.type !== "TSImportEqualsDeclaration" && (this.resetStartLocation(declaration, startLoc), declaration.declare = !0), declaration) : null;
  }
  parseClassId(node, isStatement, optionalId, bindingType) {
    if ((!isStatement || optionalId) && this.isContextual(tt._implements))
      return;
    super.parseClassId(node, isStatement, optionalId, node.declare ? BindingFlag.TYPE_TS_AMBIENT : BindingFlag.TYPE_CLASS);
    const typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutConstModifiers);
    typeParameters && (node.typeParameters = typeParameters);
  }
  parseClassPropertyAnnotation(node) {
    node.optional || (this.eat(tt.bang) ? node.definite = !0 : this.eat(tt.question) && (node.optional = !0));
    const type = this.tsTryParseTypeAnnotation();
    type && (node.typeAnnotation = type);
  }
  parseClassProperty(node) {
    if (this.parseClassPropertyAnnotation(node), this.state.isAmbientContext && !(node.readonly && !node.typeAnnotation) && this.match(tt.eq) && this.raise(TSErrors.DeclareClassFieldHasInitializer, this.state.startLoc), node.abstract && this.match(tt.eq)) {
      const {
        key
      } = node;
      this.raise(TSErrors.AbstractPropertyHasInitializer, this.state.startLoc, {
        propertyName: key.type === "Identifier" && !node.computed ? key.name : `[${this.input.slice(this.offsetToSourcePos(key.start), this.offsetToSourcePos(key.end))}]`
      });
    }
    return super.parseClassProperty(node);
  }
  parseClassPrivateProperty(node) {
    return node.abstract && this.raise(TSErrors.PrivateElementHasAbstract, node), node.accessibility && this.raise(TSErrors.PrivateElementHasAccessibility, node, {
      modifier: node.accessibility
    }), this.parseClassPropertyAnnotation(node), super.parseClassPrivateProperty(node);
  }
  parseClassAccessorProperty(node) {
    return this.parseClassPropertyAnnotation(node), node.optional && this.raise(TSErrors.AccessorCannotBeOptional, node), super.parseClassAccessorProperty(node);
  }
  pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
    const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
    typeParameters && isConstructor && this.raise(TSErrors.ConstructorHasTypeParameters, typeParameters);
    const {
      declare = !1,
      kind
    } = method;
    declare && (kind === "get" || kind === "set") && this.raise(TSErrors.DeclareAccessor, method, {
      kind
    }), typeParameters && (method.typeParameters = typeParameters), super.pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper);
  }
  pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
    const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
    typeParameters && (method.typeParameters = typeParameters), super.pushClassPrivateMethod(classBody, method, isGenerator, isAsync);
  }
  declareClassPrivateMethodInScope(node, kind) {
    node.type !== "TSDeclareMethod" && (node.type === "MethodDefinition" && node.value.body == null || super.declareClassPrivateMethodInScope(node, kind));
  }
  parseClassSuper(node) {
    if (super.parseClassSuper(node), node.superClass)
      if (node.superClass.type === "TSInstantiationExpression") {
        const tsInstantiationExpression = node.superClass, superClass2 = tsInstantiationExpression.expression;
        this.takeSurroundingComments(superClass2, superClass2.start, superClass2.end);
        const superTypeArguments = tsInstantiationExpression.typeParameters;
        this.takeSurroundingComments(superTypeArguments, superTypeArguments.start, superTypeArguments.end), node.superClass = superClass2, node.superTypeParameters = superTypeArguments;
      } else (this.match(tt.lt) || this.match(tt.bitShiftL)) && (node.superTypeParameters = this.tsParseTypeArgumentsInExpression());
    this.eatContextual(tt._implements) && (node.implements = this.tsParseHeritageClause("implements"));
  }
  parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
    const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
    return typeParameters && (prop.typeParameters = typeParameters), super.parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors);
  }
  parseFunctionParams(node, isConstructor) {
    const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
    typeParameters && (node.typeParameters = typeParameters), super.parseFunctionParams(node, isConstructor);
  }
  parseVarId(decl, kind) {
    super.parseVarId(decl, kind), decl.id.type === "Identifier" && !this.hasPrecedingLineBreak() && this.eat(tt.bang) && (decl.definite = !0);
    const type = this.tsTryParseTypeAnnotation();
    type && (decl.id.typeAnnotation = type, this.resetEndLocation(decl.id));
  }
  parseAsyncArrowFromCallExpression(node, call) {
    return this.match(tt.colon) && (node.returnType = this.tsParseTypeAnnotation()), super.parseAsyncArrowFromCallExpression(node, call);
  }
  parseMaybeAssign(refExpressionErrors, afterLeftParse) {
    let state, jsx, typeCast;
    if (this.hasPlugin("jsx") && (this.match(tt.jsxTagStart) || this.match(tt.lt))) {
      if (state = this.state.clone(), jsx = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state), !jsx.error) return jsx.node;
      const {
        context
      } = this.state, currentContext = context[context.length - 1];
      (currentContext === tc.j_oTag || currentContext === tc.j_expr) && context.pop();
    }
    if (!jsx?.error && !this.match(tt.lt))
      return super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
    (!state || state === this.state) && (state = this.state.clone());
    let typeParameters;
    const arrow = this.tryParse((abort) => {
      typeParameters = this.tsParseTypeParameters(this.tsParseConstModifier);
      const expr = super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
      return (expr.type !== "ArrowFunctionExpression" || expr.extra?.parenthesized) && abort(), typeParameters?.params.length !== 0 && this.resetStartLocationFromNode(expr, typeParameters), expr.typeParameters = typeParameters, expr;
    }, state);
    if (!arrow.error && !arrow.aborted)
      return typeParameters && this.reportReservedArrowTypeParam(typeParameters), arrow.node;
    if (!jsx && (assert(!this.hasPlugin("jsx")), typeCast = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state), !typeCast.error))
      return typeCast.node;
    if (jsx?.node)
      return this.state = jsx.failState, jsx.node;
    if (arrow.node)
      return this.state = arrow.failState, typeParameters && this.reportReservedArrowTypeParam(typeParameters), arrow.node;
    if (typeCast?.node)
      return this.state = typeCast.failState, typeCast.node;
    throw jsx?.error || arrow.error || typeCast?.error;
  }
  reportReservedArrowTypeParam(node) {
    node.params.length === 1 && !node.params[0].constraint && !node.extra?.trailingComma && this.getPluginOption("typescript", "disallowAmbiguousJSXLike") && this.raise(TSErrors.ReservedArrowTypeParam, node);
  }
  parseMaybeUnary(refExpressionErrors, sawUnary) {
    return !this.hasPlugin("jsx") && this.match(tt.lt) ? this.tsParseTypeAssertion() : super.parseMaybeUnary(refExpressionErrors, sawUnary);
  }
  parseArrow(node) {
    if (this.match(tt.colon)) {
      const result = this.tryParse((abort) => {
        const returnType = this.tsParseTypeOrTypePredicateAnnotation(tt.colon);
        return (this.canInsertSemicolon() || !this.match(tt.arrow)) && abort(), returnType;
      });
      if (result.aborted) return;
      result.thrown || (result.error && (this.state = result.failState), node.returnType = result.node);
    }
    return super.parseArrow(node);
  }
  parseFunctionParamType(param) {
    this.eat(tt.question) && (param.optional = !0);
    const type = this.tsTryParseTypeAnnotation();
    return type && (param.typeAnnotation = type), this.resetEndLocation(param), param;
  }
  isAssignable(node, isBinding) {
    switch (node.type) {
      case "TSTypeCastExpression":
        return this.isAssignable(node.expression, isBinding);
      case "TSParameterProperty":
        return !0;
      default:
        return super.isAssignable(node, isBinding);
    }
  }
  toAssignable(node, isLHS = !1) {
    switch (node.type) {
      case "ParenthesizedExpression":
        this.toAssignableParenthesizedExpression(node, isLHS);
        break;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
        isLHS ? this.expressionScope.recordArrowParameterBindingError(TSErrors.UnexpectedTypeCastInParameter, node) : this.raise(TSErrors.UnexpectedTypeCastInParameter, node), this.toAssignable(node.expression, isLHS);
        break;
      case "AssignmentExpression":
        !isLHS && node.left.type === "TSTypeCastExpression" && (node.left = this.typeCastToParameter(node.left));
      default:
        super.toAssignable(node, isLHS);
    }
  }
  toAssignableParenthesizedExpression(node, isLHS) {
    switch (node.expression.type) {
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "ParenthesizedExpression":
        this.toAssignable(node.expression, isLHS);
        break;
      default:
        super.toAssignable(node, isLHS);
    }
  }
  checkToRestConversion(node, allowPattern) {
    switch (node.type) {
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
        this.checkToRestConversion(node.expression, !1);
        break;
      default:
        super.checkToRestConversion(node, allowPattern);
    }
  }
  isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
    switch (type) {
      case "TSTypeCastExpression":
        return !0;
      case "TSParameterProperty":
        return "parameter";
      case "TSNonNullExpression":
        return "expression";
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
        return (binding !== BindingFlag.TYPE_NONE || !isUnparenthesizedInAssign) && ["expression", !0];
      default:
        return super.isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding);
    }
  }
  parseBindingAtom() {
    return this.state.type === tt._this ? this.parseIdentifier(!0) : super.parseBindingAtom();
  }
  parseMaybeDecoratorArguments(expr, startLoc) {
    if (this.match(tt.lt) || this.match(tt.bitShiftL)) {
      const typeArguments = this.tsParseTypeArgumentsInExpression();
      if (this.match(tt.parenL)) {
        const call = super.parseMaybeDecoratorArguments(expr, startLoc);
        return call.typeParameters = typeArguments, call;
      }
      this.unexpected(null, tt.parenL);
    }
    return super.parseMaybeDecoratorArguments(expr, startLoc);
  }
  checkCommaAfterRest(close) {
    return this.state.isAmbientContext && this.match(tt.comma) && this.lookaheadCharCode() === close ? (this.next(), !1) : super.checkCommaAfterRest(close);
  }
  isClassMethod() {
    return this.match(tt.lt) || super.isClassMethod();
  }
  isClassProperty() {
    return this.match(tt.bang) || this.match(tt.colon) || super.isClassProperty();
  }
  parseMaybeDefault(startLoc, left) {
    const node = super.parseMaybeDefault(startLoc, left);
    return node.type === "AssignmentPattern" && node.typeAnnotation && node.right.start < node.typeAnnotation.start && this.raise(TSErrors.TypeAnnotationAfterAssign, node.typeAnnotation), node;
  }
  getTokenFromCode(code) {
    if (this.state.inType) {
      if (code === 62) {
        this.finishOp(tt.gt, 1);
        return;
      }
      if (code === 60) {
        this.finishOp(tt.lt, 1);
        return;
      }
    }
    super.getTokenFromCode(code);
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
  toAssignableListItem(exprList, index, isLHS) {
    const node = exprList[index];
    node.type === "TSTypeCastExpression" && (exprList[index] = this.typeCastToParameter(node)), super.toAssignableListItem(exprList, index, isLHS);
  }
  typeCastToParameter(node) {
    return node.expression.typeAnnotation = node.typeAnnotation, this.resetEndLocation(node.expression, node.typeAnnotation.loc.end), node.expression;
  }
  shouldParseArrow(params) {
    return this.match(tt.colon) ? params.every((expr) => this.isAssignable(expr, !0)) : super.shouldParseArrow(params);
  }
  shouldParseAsyncArrow() {
    return this.match(tt.colon) || super.shouldParseAsyncArrow();
  }
  canHaveLeadingDecorator() {
    return super.canHaveLeadingDecorator() || this.isAbstractClass();
  }
  jsxParseOpeningElementAfterName(node) {
    if (this.match(tt.lt) || this.match(tt.bitShiftL)) {
      const typeArguments = this.tsTryParseAndCatch(() => this.tsParseTypeArgumentsInExpression());
      typeArguments && (node.typeParameters = typeArguments);
    }
    return super.jsxParseOpeningElementAfterName(node);
  }
  getGetterSetterExpectedParamCount(method) {
    const baseCount = super.getGetterSetterExpectedParamCount(method), firstParam = this.getObjectOrClassMethodParams(method)[0];
    return firstParam && this.isThisParam(firstParam) ? baseCount + 1 : baseCount;
  }
  parseCatchClauseParam() {
    const param = super.parseCatchClauseParam(), type = this.tsTryParseTypeAnnotation();
    return type && (param.typeAnnotation = type, this.resetEndLocation(param)), param;
  }
  tsInAmbientContext(cb) {
    const {
      isAmbientContext: oldIsAmbientContext,
      strict: oldStrict
    } = this.state;
    this.state.isAmbientContext = !0, this.state.strict = !1;
    try {
      return cb();
    } finally {
      this.state.isAmbientContext = oldIsAmbientContext, this.state.strict = oldStrict;
    }
  }
  parseClass(node, isStatement, optionalId) {
    const oldInAbstractClass = this.state.inAbstractClass;
    this.state.inAbstractClass = !!node.abstract;
    try {
      return super.parseClass(node, isStatement, optionalId);
    } finally {
      this.state.inAbstractClass = oldInAbstractClass;
    }
  }
  tsParseAbstractDeclaration(node, decorators) {
    if (this.match(tt._class))
      return node.abstract = !0, this.maybeTakeDecorators(decorators, this.parseClass(node, !0, !1));
    if (this.isContextual(tt._interface))
      return this.hasFollowingLineBreak() ? null : (node.abstract = !0, this.raise(TSErrors.NonClassMethodPropertyHasAbstractModifier, node), this.tsParseInterfaceDeclaration(node));
    throw this.unexpected(null, tt._class);
  }
  parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope) {
    const method = super.parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope);
    if ((method.abstract || method.type === "TSAbstractMethodDefinition") && (this.hasPlugin("estree") ? method.value : method).body) {
      const {
        key
      } = method;
      this.raise(TSErrors.AbstractMethodHasImplementation, method, {
        methodName: key.type === "Identifier" && !method.computed ? key.name : `[${this.input.slice(this.offsetToSourcePos(key.start), this.offsetToSourcePos(key.end))}]`
      });
    }
    return method;
  }
  tsParseTypeParameterName() {
    return this.parseIdentifier().name;
  }
  shouldParseAsAmbientContext() {
    return !!this.getPluginOption("typescript", "dts");
  }
  parse() {
    return this.shouldParseAsAmbientContext() && (this.state.isAmbientContext = !0), super.parse();
  }
  getExpression() {
    return this.shouldParseAsAmbientContext() && (this.state.isAmbientContext = !0), super.getExpression();
  }
  parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly) {
    return !isString && isMaybeTypeOnly ? (this.parseTypeOnlyImportExportSpecifier(node, !1, isInTypeExport), this.finishNode(node, "ExportSpecifier")) : (node.exportKind = "value", super.parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly));
  }
  parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
    return !importedIsString && isMaybeTypeOnly ? (this.parseTypeOnlyImportExportSpecifier(specifier, !0, isInTypeOnlyImport), this.finishNode(specifier, "ImportSpecifier")) : (specifier.importKind = "value", super.parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, isInTypeOnlyImport ? BindingFlag.TYPE_TS_TYPE_IMPORT : BindingFlag.TYPE_TS_VALUE_IMPORT));
  }
  parseTypeOnlyImportExportSpecifier(node, isImport, isInTypeOnlyImportExport) {
    const leftOfAsKey = isImport ? "imported" : "local", rightOfAsKey = isImport ? "local" : "exported";
    let leftOfAs = node[leftOfAsKey], rightOfAs, hasTypeSpecifier = !1, canParseAsKeyword = !0;
    const loc = leftOfAs.loc.start;
    if (this.isContextual(tt._as)) {
      const firstAs = this.parseIdentifier();
      if (this.isContextual(tt._as)) {
        const secondAs = this.parseIdentifier();
        tokenIsKeywordOrIdentifier(this.state.type) ? (hasTypeSpecifier = !0, leftOfAs = firstAs, rightOfAs = isImport ? this.parseIdentifier() : this.parseModuleExportName(), canParseAsKeyword = !1) : (rightOfAs = secondAs, canParseAsKeyword = !1);
      } else tokenIsKeywordOrIdentifier(this.state.type) ? (canParseAsKeyword = !1, rightOfAs = isImport ? this.parseIdentifier() : this.parseModuleExportName()) : (hasTypeSpecifier = !0, leftOfAs = firstAs);
    } else tokenIsKeywordOrIdentifier(this.state.type) && (hasTypeSpecifier = !0, isImport ? (leftOfAs = this.parseIdentifier(!0), this.isContextual(tt._as) || this.checkReservedWord(leftOfAs.name, leftOfAs.loc.start, !0, !0)) : leftOfAs = this.parseModuleExportName());
    hasTypeSpecifier && isInTypeOnlyImportExport && this.raise(isImport ? TSErrors.TypeModifierIsUsedInTypeImports : TSErrors.TypeModifierIsUsedInTypeExports, loc), node[leftOfAsKey] = leftOfAs, node[rightOfAsKey] = rightOfAs;
    const kindKey = isImport ? "importKind" : "exportKind";
    node[kindKey] = hasTypeSpecifier ? "type" : "value", canParseAsKeyword && this.eatContextual(tt._as) && (node[rightOfAsKey] = isImport ? this.parseIdentifier() : this.parseModuleExportName()), node[rightOfAsKey] || (node[rightOfAsKey] = this.cloneIdentifier(node[leftOfAsKey])), isImport && this.checkIdentifier(node[rightOfAsKey], hasTypeSpecifier ? BindingFlag.TYPE_TS_TYPE_IMPORT : BindingFlag.TYPE_TS_VALUE_IMPORT);
  }
  fillOptionalPropertiesForTSESLint(node) {
    switch (node.type) {
      case "ExpressionStatement":
        node.directive ??= void 0;
        return;
      case "RestElement":
        node.value = void 0;
      case "Identifier":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "ObjectPattern":
        node.decorators ??= [], node.optional ??= !1, node.typeAnnotation ??= void 0;
        return;
      case "TSParameterProperty":
        node.accessibility ??= void 0, node.decorators ??= [], node.override ??= !1, node.readonly ??= !1, node.static ??= !1;
        return;
      case "TSEmptyBodyFunctionExpression":
        node.body = null;
      case "TSDeclareFunction":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ClassMethod":
      case "ClassPrivateMethod":
        node.declare ??= !1, node.returnType ??= void 0, node.typeParameters ??= void 0;
        return;
      case "Property":
        node.optional ??= !1;
        return;
      case "TSMethodSignature":
      case "TSPropertySignature":
        node.optional ??= !1;
      case "TSIndexSignature":
        node.accessibility ??= void 0, node.readonly ??= !1, node.static ??= !1;
        return;
      case "TSAbstractPropertyDefinition":
      case "PropertyDefinition":
      case "TSAbstractAccessorProperty":
      case "AccessorProperty":
        node.declare ??= !1, node.definite ??= !1, node.readonly ??= !1, node.typeAnnotation ??= void 0;
      case "TSAbstractMethodDefinition":
      case "MethodDefinition":
        node.accessibility ??= void 0, node.decorators ??= [], node.override ??= !1, node.optional ??= !1;
        return;
      case "ClassExpression":
        node.id ??= null;
      case "ClassDeclaration":
        node.abstract ??= !1, node.declare ??= !1, node.decorators ??= [], node.implements ??= [], node.superTypeArguments ??= void 0, node.typeParameters ??= void 0;
        return;
      case "TSTypeAliasDeclaration":
      case "VariableDeclaration":
        node.declare ??= !1;
        return;
      case "VariableDeclarator":
        node.definite ??= !1;
        return;
      case "TSEnumDeclaration":
        node.const ??= !1, node.declare ??= !1;
        return;
      case "TSEnumMember":
        node.computed ??= !1;
        return;
      case "TSImportType":
        node.qualifier ??= null, node.options ??= null;
        return;
      case "TSInterfaceDeclaration":
        node.declare ??= !1, node.extends ??= [];
        return;
      case "TSMappedType":
        node.optional ??= !1, node.readonly ??= void 0;
        return;
      case "TSModuleDeclaration":
        node.declare ??= !1, node.global ??= node.kind === "global";
        return;
      case "TSTypeParameter":
        node.const ??= !1, node.in ??= !1, node.out ??= !1;
        return;
    }
  }
  chStartsBindingIdentifierAndNotRelationalOperator(ch, pos) {
    if (isIdentifierStart(ch)) {
      if (keywordAndTSRelationalOperator.lastIndex = pos, keywordAndTSRelationalOperator.test(this.input)) {
        const endCh = this.codePointAtPos(keywordAndTSRelationalOperator.lastIndex);
        if (!isIdentifierChar(endCh) && endCh !== 92)
          return !1;
      }
      return !0;
    } else return ch === 92;
  }
  nextTokenIsIdentifierAndNotTSRelationalOperatorOnSameLine() {
    const next = this.nextTokenInLineStart(), nextCh = this.codePointAtPos(next);
    return this.chStartsBindingIdentifierAndNotRelationalOperator(nextCh, next);
  }
  nextTokenIsIdentifierOrStringLiteralOnSameLine() {
    const next = this.nextTokenInLineStart(), nextCh = this.codePointAtPos(next);
    return this.chStartsBindingIdentifier(nextCh, next) || nextCh === 34 || nextCh === 39;
  }
};
function isPossiblyLiteralEnum(expression) {
  if (expression.type !== "MemberExpression") return !1;
  const {
    computed,
    property
  } = expression;
  return computed && property.type !== "StringLiteral" && (property.type !== "TemplateLiteral" || property.expressions.length > 0) ? !1 : isUncomputedMemberExpressionChain(expression.object);
}
function isValidAmbientConstInitializer(expression, estree) {
  const {
    type
  } = expression;
  if (expression.extra?.parenthesized)
    return !1;
  if (estree) {
    if (type === "Literal") {
      const {
        value
      } = expression;
      if (typeof value == "string" || typeof value == "boolean")
        return !0;
    }
  } else if (type === "StringLiteral" || type === "BooleanLiteral")
    return !0;
  return !!(isNumber(expression, estree) || isNegativeNumber(expression, estree) || type === "TemplateLiteral" && expression.expressions.length === 0 || isPossiblyLiteralEnum(expression));
}
function isNumber(expression, estree) {
  return estree ? expression.type === "Literal" && (typeof expression.value == "number" || "bigint" in expression) : expression.type === "NumericLiteral" || expression.type === "BigIntLiteral";
}
function isNegativeNumber(expression, estree) {
  if (expression.type === "UnaryExpression") {
    const {
      operator,
      argument
    } = expression;
    if (operator === "-" && isNumber(argument, estree))
      return !0;
  }
  return !1;
}
function isUncomputedMemberExpressionChain(expression) {
  return expression.type === "Identifier" ? !0 : expression.type !== "MemberExpression" || expression.computed ? !1 : isUncomputedMemberExpressionChain(expression.object);
}
export {
  stdin_default as default,
  tsParseEntityNameFlags
};
