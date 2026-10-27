// Generated from Babel v7.29.8 (MIT); see README.md.
import { ScopeFlag, BindingFlag } from "./scopeflags.mjs";
import { Errors } from "../parse-error.mjs";
var NameType = {
  Var: 1,
  Lexical: 2,
  Function: 4
};
class Scope {
  flags = 0;
  names = /* @__PURE__ */ new Map();
  firstLexicalName = "";
  constructor(flags) {
    this.flags = flags;
  }
}
class ScopeHandler {
  parser;
  scopeStack = [];
  inModule;
  undefinedExports = /* @__PURE__ */ new Map();
  constructor(parser, inModule) {
    this.parser = parser, this.inModule = inModule;
  }
  get inTopLevel() {
    return (this.currentScope().flags & ScopeFlag.PROGRAM) > 0;
  }
  get inFunction() {
    return (this.currentVarScopeFlags() & ScopeFlag.FUNCTION_BASE) > 0;
  }
  get allowSuper() {
    return (this.currentThisScopeFlags() & ScopeFlag.SUPER) > 0;
  }
  get allowDirectSuper() {
    return (this.currentThisScopeFlags() & ScopeFlag.DIRECT_SUPER) > 0;
  }
  get allowNewTarget() {
    return (this.currentThisScopeFlags() & ScopeFlag.NEW_TARGET) > 0;
  }
  get inClass() {
    return (this.currentThisScopeFlags() & ScopeFlag.CLASS_BASE) > 0;
  }
  get inClassAndNotInNonArrowFunction() {
    const flags = this.currentThisScopeFlags();
    return (flags & ScopeFlag.CLASS_BASE) > 0 && (flags & ScopeFlag.FUNCTION_BASE) === 0;
  }
  get inStaticBlock() {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const {
        flags
      } = this.scopeStack[i];
      if (flags & ScopeFlag.STATIC_BLOCK)
        return !0;
      if (flags & (ScopeFlag.VAR | ScopeFlag.CLASS_BASE))
        return !1;
    }
  }
  get inNonArrowFunction() {
    return (this.currentThisScopeFlags() & ScopeFlag.FUNCTION_BASE) > 0;
  }
  get inBareCaseStatement() {
    return (this.currentScope().flags & ScopeFlag.SWITCH) > 0;
  }
  get treatFunctionsAsVar() {
    return this.treatFunctionsAsVarInScope(this.currentScope());
  }
  createScope(flags) {
    return new Scope(flags);
  }
  enter(flags) {
    this.scopeStack.push(this.createScope(flags));
  }
  exit() {
    return this.scopeStack.pop().flags;
  }
  treatFunctionsAsVarInScope(scope) {
    return !!(scope.flags & (ScopeFlag.FUNCTION_BASE | ScopeFlag.STATIC_BLOCK) || !this.parser.inModule && scope.flags & ScopeFlag.PROGRAM);
  }
  declareName(name, bindingType, loc) {
    let scope = this.currentScope();
    if (bindingType & BindingFlag.SCOPE_LEXICAL || bindingType & BindingFlag.SCOPE_FUNCTION) {
      this.checkRedeclarationInScope(scope, name, bindingType, loc);
      let type = scope.names.get(name) || 0;
      bindingType & BindingFlag.SCOPE_FUNCTION ? type = type | NameType.Function : (scope.firstLexicalName || (scope.firstLexicalName = name), type = type | NameType.Lexical), scope.names.set(name, type), bindingType & BindingFlag.SCOPE_LEXICAL && this.maybeExportDefined(scope, name);
    } else if (bindingType & BindingFlag.SCOPE_VAR)
      for (let i = this.scopeStack.length - 1; i >= 0 && (scope = this.scopeStack[i], this.checkRedeclarationInScope(scope, name, bindingType, loc), scope.names.set(name, (scope.names.get(name) || 0) | NameType.Var), this.maybeExportDefined(scope, name), !(scope.flags & ScopeFlag.VAR)); --i)
        ;
    this.parser.inModule && scope.flags & ScopeFlag.PROGRAM && this.undefinedExports.delete(name);
  }
  maybeExportDefined(scope, name) {
    this.parser.inModule && scope.flags & ScopeFlag.PROGRAM && this.undefinedExports.delete(name);
  }
  checkRedeclarationInScope(scope, name, bindingType, loc) {
    this.isRedeclaredInScope(scope, name, bindingType) && this.parser.raise(Errors.VarRedeclaration, loc, {
      identifierName: name
    });
  }
  isRedeclaredInScope(scope, name, bindingType) {
    if (!(bindingType & BindingFlag.KIND_VALUE)) return !1;
    if (bindingType & BindingFlag.SCOPE_LEXICAL)
      return scope.names.has(name);
    const type = scope.names.get(name) || 0;
    return bindingType & BindingFlag.SCOPE_FUNCTION ? (type & NameType.Lexical) > 0 || !this.treatFunctionsAsVarInScope(scope) && (type & NameType.Var) > 0 : (type & NameType.Lexical) > 0 && !(scope.flags & ScopeFlag.SIMPLE_CATCH && scope.firstLexicalName === name) || !this.treatFunctionsAsVarInScope(scope) && (type & NameType.Function) > 0;
  }
  checkLocalExport(id) {
    const {
      name
    } = id;
    this.scopeStack[0].names.has(name) || this.undefinedExports.set(name, id.loc.start);
  }
  currentScope() {
    return this.scopeStack[this.scopeStack.length - 1];
  }
  currentVarScopeFlags() {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const {
        flags
      } = this.scopeStack[i];
      if (flags & ScopeFlag.VAR)
        return flags;
    }
  }
  currentThisScopeFlags() {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const {
        flags
      } = this.scopeStack[i];
      if (flags & (ScopeFlag.VAR | ScopeFlag.CLASS_BASE) && !(flags & ScopeFlag.ARROW))
        return flags;
    }
  }
}
export {
  NameType,
  Scope,
  ScopeHandler as default
};
