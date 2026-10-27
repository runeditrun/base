// Generated from Babel v7.29.8 (MIT); see README.md.
import { ClassElementType } from "./scopeflags.mjs";
import { Errors } from "../parse-error.mjs";
class ClassScope {
  privateNames = /* @__PURE__ */ new Set();
  loneAccessors = /* @__PURE__ */ new Map();
  undefinedPrivateNames = /* @__PURE__ */ new Map();
}
class ClassScopeHandler {
  parser;
  stack = [];
  undefinedPrivateNames = /* @__PURE__ */ new Map();
  constructor(parser) {
    this.parser = parser;
  }
  current() {
    return this.stack[this.stack.length - 1];
  }
  enter() {
    this.stack.push(new ClassScope());
  }
  exit() {
    const oldClassScope = this.stack.pop(), current = this.current();
    for (const [name, loc] of Array.from(oldClassScope.undefinedPrivateNames))
      current ? current.undefinedPrivateNames.has(name) || current.undefinedPrivateNames.set(name, loc) : this.parser.raise(Errors.InvalidPrivateFieldResolution, loc, {
        identifierName: name
      });
  }
  declarePrivateName(name, elementType, loc) {
    const {
      privateNames,
      loneAccessors,
      undefinedPrivateNames
    } = this.current();
    let redefined = privateNames.has(name);
    if (elementType & ClassElementType.KIND_ACCESSOR) {
      const accessor = redefined && loneAccessors.get(name);
      if (accessor) {
        const oldStatic = accessor & ClassElementType.FLAG_STATIC, newStatic = elementType & ClassElementType.FLAG_STATIC, oldKind = accessor & ClassElementType.KIND_ACCESSOR, newKind = elementType & ClassElementType.KIND_ACCESSOR;
        redefined = oldKind === newKind || oldStatic !== newStatic, redefined || loneAccessors.delete(name);
      } else redefined || loneAccessors.set(name, elementType);
    }
    redefined && this.parser.raise(Errors.PrivateNameRedeclaration, loc, {
      identifierName: name
    }), privateNames.add(name), undefinedPrivateNames.delete(name);
  }
  usePrivateName(name, loc) {
    let classScope;
    for (classScope of this.stack)
      if (classScope.privateNames.has(name)) return;
    classScope ? classScope.undefinedPrivateNames.set(name, loc) : this.parser.raise(Errors.InvalidPrivateFieldResolution, loc, {
      identifierName: name
    });
  }
}
export {
  ClassScope,
  ClassScopeHandler as default
};
