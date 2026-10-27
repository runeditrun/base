// Generated from Babel v7.29.8 (MIT); see README.md.
import ScopeHandler, { NameType, Scope } from "../../util/scope.mjs";
import { BindingFlag, ScopeFlag } from "../../util/scopeflags.mjs";
import { Errors } from "../../parse-error.mjs";
class TypeScriptScope extends Scope {
  tsNames = /* @__PURE__ */ new Map();
}
class TypeScriptScopeHandler extends ScopeHandler {
  importsStack = [];
  createScope(flags) {
    return this.importsStack.push(/* @__PURE__ */ new Set()), new TypeScriptScope(flags);
  }
  enter(flags) {
    flags === ScopeFlag.TS_MODULE && this.importsStack.push(/* @__PURE__ */ new Set()), super.enter(flags);
  }
  exit() {
    const flags = super.exit();
    return flags === ScopeFlag.TS_MODULE && this.importsStack.pop(), flags;
  }
  hasImport(name, allowShadow) {
    const len = this.importsStack.length;
    if (this.importsStack[len - 1].has(name))
      return !0;
    if (!allowShadow && len > 1) {
      for (let i = 0; i < len - 1; i++)
        if (this.importsStack[i].has(name)) return !0;
    }
    return !1;
  }
  declareName(name, bindingType, loc) {
    if (bindingType & BindingFlag.FLAG_TS_IMPORT) {
      this.hasImport(name, !0) && this.parser.raise(Errors.VarRedeclaration, loc, {
        identifierName: name
      }), this.importsStack[this.importsStack.length - 1].add(name);
      return;
    }
    const scope = this.currentScope();
    let type = scope.tsNames.get(name) || 0;
    if (bindingType & BindingFlag.FLAG_TS_EXPORT_ONLY) {
      this.maybeExportDefined(scope, name), scope.tsNames.set(name, type | 16);
      return;
    }
    super.declareName(name, bindingType, loc), bindingType & BindingFlag.KIND_TYPE && (bindingType & BindingFlag.KIND_VALUE || (this.checkRedeclarationInScope(scope, name, bindingType, loc), this.maybeExportDefined(scope, name)), type = type | 1), bindingType & BindingFlag.FLAG_TS_ENUM && (type = type | 2), bindingType & BindingFlag.FLAG_TS_CONST_ENUM && (type = type | 4), bindingType & BindingFlag.FLAG_CLASS && (type = type | 8), type && scope.tsNames.set(name, type);
  }
  isRedeclaredInScope(scope, name, bindingType) {
    const type = scope.tsNames.get(name);
    if ((type & 2) > 0) {
      if (bindingType & BindingFlag.FLAG_TS_ENUM) {
        const isConst = !!(bindingType & BindingFlag.FLAG_TS_CONST_ENUM), wasConst = (type & 4) > 0;
        return isConst !== wasConst;
      }
      return !0;
    }
    return bindingType & BindingFlag.FLAG_CLASS && (type & 8) > 0 ? scope.names.get(name) & NameType.Lexical ? !!(bindingType & BindingFlag.KIND_VALUE) : !1 : bindingType & BindingFlag.KIND_TYPE && (type & 1) > 0 ? !0 : super.isRedeclaredInScope(scope, name, bindingType);
  }
  checkLocalExport(id) {
    const {
      name
    } = id;
    if (this.hasImport(name)) return;
    const len = this.scopeStack.length;
    for (let i = len - 1; i >= 0; i--) {
      const type = this.scopeStack[i].tsNames.get(name);
      if ((type & 1) > 0 || (type & 16) > 0)
        return;
    }
    super.checkLocalExport(id);
  }
}
export {
  TypeScriptScopeHandler as default
};
