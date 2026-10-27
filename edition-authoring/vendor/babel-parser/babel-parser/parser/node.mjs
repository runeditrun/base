// Generated from Babel v7.29.8 (MIT); see README.md.
import UtilParser from "./util.mjs";
import { SourceLocation } from "../util/location.mjs";
import { OptionFlags } from "../options.mjs";
class Node {
  constructor(parser, pos, loc) {
    this.start = pos, this.end = 0, this.loc = new SourceLocation(loc), parser?.optionFlags & OptionFlags.Ranges && (this.range = [pos, 0]), parser?.filename && (this.loc.filename = parser.filename);
  }
  type = "";
}
const NodePrototype = Node.prototype;
NodePrototype.__clone = function() {
  const newNode = new Node(void 0, this.start, this.loc.start), keys = Object.keys(this);
  for (let i = 0, length = keys.length; i < length; i++) {
    const key = keys[i];
    key !== "leadingComments" && key !== "trailingComments" && key !== "innerComments" && (newNode[key] = this[key]);
  }
  return newNode;
};
class NodeUtils extends UtilParser {
  startNode() {
    const loc = this.state.startLoc;
    return new Node(this, loc.index, loc);
  }
  startNodeAt(loc) {
    return new Node(this, loc.index, loc);
  }
  startNodeAtNode(type) {
    return this.startNodeAt(type.loc.start);
  }
  finishNode(node, type) {
    return this.finishNodeAt(node, type, this.state.lastTokEndLoc);
  }
  finishNodeAt(node, type, endLoc) {
    return node.type = type, node.end = endLoc.index, node.loc.end = endLoc, this.optionFlags & OptionFlags.Ranges && (node.range[1] = endLoc.index), this.optionFlags & OptionFlags.AttachComment && this.processComment(node), node;
  }
  resetStartLocation(node, startLoc) {
    node.start = startLoc.index, node.loc.start = startLoc, this.optionFlags & OptionFlags.Ranges && (node.range[0] = startLoc.index);
  }
  resetEndLocation(node, endLoc = this.state.lastTokEndLoc) {
    node.end = endLoc.index, node.loc.end = endLoc, this.optionFlags & OptionFlags.Ranges && (node.range[1] = endLoc.index);
  }
  resetStartLocationFromNode(node, locationNode) {
    this.resetStartLocation(node, locationNode.loc.start);
  }
  castNodeTo(node, type) {
    return node.type = type, node;
  }
  cloneIdentifier(node) {
    const {
      type,
      start,
      end,
      loc,
      range,
      name
    } = node, cloned = Object.create(NodePrototype);
    return cloned.type = type, cloned.start = start, cloned.end = end, cloned.loc = loc, cloned.range = range, cloned.name = name, node.extra && (cloned.extra = node.extra), cloned;
  }
  cloneStringLiteral(node) {
    const {
      type,
      start,
      end,
      loc,
      range,
      extra
    } = node, cloned = Object.create(NodePrototype);
    return cloned.type = type, cloned.start = start, cloned.end = end, cloned.loc = loc, cloned.range = range, cloned.extra = extra, cloned.value = node.value, cloned;
  }
}
export {
  NodeUtils
};
