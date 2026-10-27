// Generated from Babel v7.29.8 (MIT); see README.md.
class BaseParser {
  sawUnambiguousESM = !1;
  ambiguousScriptDifferentAst = !1;
  sourceToOffsetPos(sourcePos) {
    return sourcePos + this.startIndex;
  }
  offsetToSourcePos(offsetPos) {
    return offsetPos - this.startIndex;
  }
  hasPlugin(pluginConfig) {
    if (typeof pluginConfig == "string")
      return this.plugins.has(pluginConfig);
    {
      const [pluginName, pluginOptions] = pluginConfig;
      if (!this.hasPlugin(pluginName))
        return !1;
      const actualOptions = this.plugins.get(pluginName);
      for (const key of Object.keys(pluginOptions))
        if (actualOptions?.[key] !== pluginOptions[key])
          return !1;
      return !0;
    }
  }
  getPluginOption(plugin, name) {
    return this.plugins.get(plugin)?.[name];
  }
}
export {
  BaseParser as default
};
