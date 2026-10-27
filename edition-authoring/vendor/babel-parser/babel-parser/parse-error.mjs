// Generated from Babel v7.29.8 (MIT); see README.md.
import { Position } from "./util/location.mjs";
function defineHidden(obj, key, value) {
  Object.defineProperty(obj, key, {
    enumerable: !1,
    configurable: !0,
    value
  });
}
function toParseErrorConstructor({
  toMessage,
  code,
  reasonCode,
  syntaxPlugin
}) {
  const hasMissingPlugin = reasonCode === "MissingPlugin" || reasonCode === "MissingOneOfPlugins";
  {
    const oldReasonCodes = {
      AccessorCannotDeclareThisParameter: "AccesorCannotDeclareThisParameter",
      AccessorCannotHaveTypeParameters: "AccesorCannotHaveTypeParameters",
      ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference: "ConstInitiailizerMustBeStringOrNumericLiteralOrLiteralEnumReference",
      SetAccessorCannotHaveOptionalParameter: "SetAccesorCannotHaveOptionalParameter",
      SetAccessorCannotHaveRestParameter: "SetAccesorCannotHaveRestParameter",
      SetAccessorCannotHaveReturnType: "SetAccesorCannotHaveReturnType"
    };
    oldReasonCodes[reasonCode] && (reasonCode = oldReasonCodes[reasonCode]);
  }
  return function constructor(loc, details) {
    const error = new SyntaxError();
    return error.code = code, error.reasonCode = reasonCode, error.loc = loc, error.pos = loc.index, error.syntaxPlugin = syntaxPlugin, hasMissingPlugin && (error.missingPlugin = details.missingPlugin), defineHidden(error, "clone", function(overrides = {}) {
      const {
        line,
        column,
        index
      } = overrides.loc ?? loc;
      return constructor(new Position(line, column, index), {
        ...details,
        ...overrides.details
      });
    }), defineHidden(error, "details", details), Object.defineProperty(error, "message", {
      configurable: !0,
      get() {
        const message = `${toMessage(details)} (${loc.line}:${loc.column})`;
        return this.message = message, message;
      },
      set(value) {
        Object.defineProperty(this, "message", {
          value,
          writable: !0
        });
      }
    }), error;
  };
}
function ParseErrorEnum(argument, syntaxPlugin) {
  if (Array.isArray(argument))
    return (parseErrorTemplates) => ParseErrorEnum(parseErrorTemplates, argument[0]);
  const ParseErrorConstructors = {};
  for (const reasonCode of Object.keys(argument)) {
    const template = argument[reasonCode], {
      message,
      ...rest
    } = typeof template == "string" ? {
      message: () => template
    } : typeof template == "function" ? {
      message: template
    } : template, toMessage = typeof message == "string" ? () => message : message;
    ParseErrorConstructors[reasonCode] = toParseErrorConstructor({
      code: "BABEL_PARSER_SYNTAX_ERROR",
      reasonCode,
      toMessage,
      ...syntaxPlugin ? {
        syntaxPlugin
      } : {},
      ...rest
    });
  }
  return ParseErrorConstructors;
}
import ModuleErrors from "./parse-error/module-errors.mjs";
import StandardErrors from "./parse-error/standard-errors.mjs";
import StrictModeErrors from "./parse-error/strict-mode-errors.mjs";
import ParseExpressionErrors from "./parse-error/parse-expression-errors.mjs";
import PipelineOperatorErrors from "./parse-error/pipeline-operator-errors.mjs";
import FunctionBindErrors from "./parse-error/bind-operator-errors.mjs";
const Errors = {
  ...ParseErrorEnum(ModuleErrors),
  ...ParseErrorEnum(StandardErrors),
  ...ParseErrorEnum(StrictModeErrors),
  ...ParseErrorEnum(ParseExpressionErrors),
  ...ParseErrorEnum`pipelineOperator`(PipelineOperatorErrors),
  ...ParseErrorEnum`functionBind`(FunctionBindErrors)
};
export {
  Errors,
  ParseErrorEnum
};
