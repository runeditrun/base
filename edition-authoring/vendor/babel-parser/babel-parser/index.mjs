// Generated from Babel v7.29.8 (MIT); see README.md.
import { validatePlugins, mixinPluginNames, mixinPlugins } from "./plugin-utils.mjs";
import Parser from "./parser/index.mjs";
import { getExportedToken, tt as internalTokenTypes } from "./tokenizer/types.mjs";
function parse(input, options) {
  if (options?.sourceType === "unambiguous") {
    options = {
      ...options
    };
    try {
      options.sourceType = "module";
      const parser = getParser(options, input), ast = parser.parse();
      if (parser.sawUnambiguousESM)
        return ast;
      if (parser.ambiguousScriptDifferentAst)
        try {
          return options.sourceType = "script", getParser(options, input).parse();
        } catch {
        }
      else
        ast.program.sourceType = "script";
      return ast;
    } catch (moduleError) {
      try {
        return options.sourceType = "script", getParser(options, input).parse();
      } catch {
      }
      throw moduleError;
    }
  } else
    return getParser(options, input).parse();
}
function parseExpression(input, options) {
  const parser = getParser(options, input);
  return parser.options.strictMode && (parser.state.strict = !0), parser.getExpression();
}
function generateExportedTokenTypes(internalTokenTypes2) {
  const tokenTypes = {};
  for (const typeName of Object.keys(internalTokenTypes2))
    tokenTypes[typeName] = getExportedToken(internalTokenTypes2[typeName]);
  return tokenTypes;
}
const tokTypes = generateExportedTokenTypes(internalTokenTypes);
function getParser(options, input) {
  let cls = Parser;
  const pluginsMap = /* @__PURE__ */ new Map();
  if (options?.plugins) {
    for (const plugin of options.plugins) {
      let name, opts;
      typeof plugin == "string" ? name = plugin : [name, opts] = plugin, pluginsMap.has(name) || pluginsMap.set(name, opts || {});
    }
    validatePlugins(pluginsMap), cls = getParserClass(pluginsMap);
  }
  return new cls(options, input, pluginsMap);
}
const parserClassCache = /* @__PURE__ */ new Map();
function getParserClass(pluginsMap) {
  const pluginList = [];
  for (const name of mixinPluginNames)
    pluginsMap.has(name) && pluginList.push(name);
  const key = pluginList.join("|");
  let cls = parserClassCache.get(key);
  if (!cls) {
    cls = Parser;
    for (const plugin of pluginList)
      cls = mixinPlugins[plugin](cls);
    parserClassCache.set(key, cls);
  }
  return cls;
}
export {
  parse,
  parseExpression,
  tokTypes
};
