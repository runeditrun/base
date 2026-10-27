// Generated from Babel v7.29.8 (MIT); see README.md.
import XHTMLEntities from "./xhtml.mjs";
import { tokenComesBeforeExpression, tokenIsKeyword, tokenLabelName, tt } from "../../tokenizer/types.mjs";
import { types as tc } from "../../tokenizer/context.mjs";
import { isIdentifierChar, isIdentifierStart } from "../../util/identifier.mjs";
import { isNewLine } from "../../util/whitespace.mjs";
import { Errors, ParseErrorEnum } from "../../parse-error.mjs";
const JsxErrors = ParseErrorEnum`jsx`({
  AttributeIsEmpty: "JSX attributes must only be assigned a non-empty expression.",
  MissingClosingTagElement: ({
    openingTagName
  }) => `Expected corresponding JSX closing tag for <${openingTagName}>.`,
  MissingClosingTagFragment: "Expected corresponding JSX closing tag for <>.",
  UnexpectedSequenceExpression: "Sequence expressions cannot be directly nested inside JSX. Did you mean to wrap it in parentheses (...)?",
  UnexpectedToken: ({
    unexpected,
    HTMLEntity
  }) => `Unexpected token \`${unexpected}\`. Did you mean \`${HTMLEntity}\` or \`{'${unexpected}'}\`?`,
  UnsupportedJsxValue: "JSX value should be either an expression or a quoted JSX text.",
  UnterminatedJsxContent: "Unterminated JSX contents.",
  UnwrappedAdjacentJSXElements: "Adjacent JSX elements must be wrapped in an enclosing tag. Did you want a JSX fragment <>...</>?"
});
function isFragment(object) {
  return object ? object.type === "JSXOpeningFragment" || object.type === "JSXClosingFragment" : !1;
}
function getQualifiedJSXName(object) {
  if (object.type === "JSXIdentifier")
    return object.name;
  if (object.type === "JSXNamespacedName")
    return object.namespace.name + ":" + object.name.name;
  if (object.type === "JSXMemberExpression")
    return getQualifiedJSXName(object.object) + "." + getQualifiedJSXName(object.property);
  throw new Error("Node had unexpected type: " + object.type);
}
var stdin_default = (superClass) => class extends superClass {
  jsxReadToken() {
    let out = "", chunkStart = this.state.pos;
    for (; ; ) {
      if (this.state.pos >= this.length)
        throw this.raise(JsxErrors.UnterminatedJsxContent, this.state.startLoc);
      const ch = this.input.charCodeAt(this.state.pos);
      switch (ch) {
        case 60:
        case 123:
          if (this.state.pos === this.state.start) {
            ch === 60 && this.state.canStartJSXElement ? (++this.state.pos, this.finishToken(tt.jsxTagStart)) : super.getTokenFromCode(ch);
            return;
          }
          out += this.input.slice(chunkStart, this.state.pos), this.finishToken(tt.jsxText, out);
          return;
        case 38:
          out += this.input.slice(chunkStart, this.state.pos), out += this.jsxReadEntity(), chunkStart = this.state.pos;
          break;
        default:
          isNewLine(ch) ? (out += this.input.slice(chunkStart, this.state.pos), out += this.jsxReadNewLine(!0), chunkStart = this.state.pos) : ++this.state.pos;
      }
    }
  }
  jsxReadNewLine(normalizeCRLF) {
    const ch = this.input.charCodeAt(this.state.pos);
    let out;
    return ++this.state.pos, ch === 13 && this.input.charCodeAt(this.state.pos) === 10 ? (++this.state.pos, out = normalizeCRLF ? `
` : `\r
`) : out = String.fromCharCode(ch), ++this.state.curLine, this.state.lineStart = this.state.pos, out;
  }
  jsxReadString(quote) {
    let out = "", chunkStart = ++this.state.pos;
    for (; ; ) {
      if (this.state.pos >= this.length)
        throw this.raise(Errors.UnterminatedString, this.state.startLoc);
      const ch = this.input.charCodeAt(this.state.pos);
      if (ch === quote) break;
      ch === 38 ? (out += this.input.slice(chunkStart, this.state.pos), out += this.jsxReadEntity(), chunkStart = this.state.pos) : isNewLine(ch) ? (out += this.input.slice(chunkStart, this.state.pos), out += this.jsxReadNewLine(!1), chunkStart = this.state.pos) : ++this.state.pos;
    }
    out += this.input.slice(chunkStart, this.state.pos++), this.finishToken(tt.string, out);
  }
  jsxReadEntity() {
    const startPos = ++this.state.pos;
    if (this.codePointAtPos(this.state.pos) === 35) {
      ++this.state.pos;
      let radix = 10;
      this.codePointAtPos(this.state.pos) === 120 && (radix = 16, ++this.state.pos);
      const codePoint = this.readInt(radix, void 0, !1, "bail");
      if (codePoint !== null && this.codePointAtPos(this.state.pos) === 59)
        return ++this.state.pos, String.fromCodePoint(codePoint);
    } else {
      let count = 0, semi = !1;
      for (; count++ < 10 && this.state.pos < this.length && !(semi = this.codePointAtPos(this.state.pos) === 59); )
        ++this.state.pos;
      if (semi) {
        const desc = this.input.slice(startPos, this.state.pos), entity = XHTMLEntities[desc];
        if (++this.state.pos, entity)
          return entity;
      }
    }
    return this.state.pos = startPos, "&";
  }
  jsxReadWord() {
    let ch;
    const start = this.state.pos;
    do
      ch = this.input.charCodeAt(++this.state.pos);
    while (isIdentifierChar(ch) || ch === 45);
    this.finishToken(tt.jsxName, this.input.slice(start, this.state.pos));
  }
  jsxParseIdentifier() {
    const node = this.startNode();
    return this.match(tt.jsxName) ? node.name = this.state.value : tokenIsKeyword(this.state.type) ? node.name = tokenLabelName(this.state.type) : this.unexpected(), this.next(), this.finishNode(node, "JSXIdentifier");
  }
  jsxParseNamespacedName() {
    const startLoc = this.state.startLoc, name = this.jsxParseIdentifier();
    if (!this.eat(tt.colon)) return name;
    const node = this.startNodeAt(startLoc);
    return node.namespace = name, node.name = this.jsxParseIdentifier(), this.finishNode(node, "JSXNamespacedName");
  }
  jsxParseElementName() {
    const startLoc = this.state.startLoc;
    let node = this.jsxParseNamespacedName();
    if (node.type === "JSXNamespacedName")
      return node;
    for (; this.eat(tt.dot); ) {
      const newNode = this.startNodeAt(startLoc);
      newNode.object = node, newNode.property = this.jsxParseIdentifier(), node = this.finishNode(newNode, "JSXMemberExpression");
    }
    return node;
  }
  jsxParseAttributeValue() {
    let node;
    switch (this.state.type) {
      case tt.braceL:
        return node = this.startNode(), this.setContext(tc.brace), this.next(), node = this.jsxParseExpressionContainer(node, tc.j_oTag), node.expression.type === "JSXEmptyExpression" && this.raise(JsxErrors.AttributeIsEmpty, node), node;
      case tt.jsxTagStart:
      case tt.string:
        return this.parseExprAtom();
      default:
        throw this.raise(JsxErrors.UnsupportedJsxValue, this.state.startLoc);
    }
  }
  jsxParseEmptyExpression() {
    const node = this.startNodeAt(this.state.lastTokEndLoc);
    return this.finishNodeAt(node, "JSXEmptyExpression", this.state.startLoc);
  }
  jsxParseSpreadChild(node) {
    return this.next(), node.expression = this.parseExpression(), this.setContext(tc.j_expr), this.state.canStartJSXElement = !0, this.expect(tt.braceR), this.finishNode(node, "JSXSpreadChild");
  }
  jsxParseExpressionContainer(node, previousContext) {
    if (this.match(tt.braceR))
      node.expression = this.jsxParseEmptyExpression();
    else {
      const expression = this.parseExpression();
      node.expression = expression;
    }
    return this.setContext(previousContext), this.state.canStartJSXElement = !0, this.expect(tt.braceR), this.finishNode(node, "JSXExpressionContainer");
  }
  jsxParseAttribute() {
    const node = this.startNode();
    return this.match(tt.braceL) ? (this.setContext(tc.brace), this.next(), this.expect(tt.ellipsis), node.argument = this.parseMaybeAssignAllowIn(), this.setContext(tc.j_oTag), this.state.canStartJSXElement = !0, this.expect(tt.braceR), this.finishNode(node, "JSXSpreadAttribute")) : (node.name = this.jsxParseNamespacedName(), node.value = this.eat(tt.eq) ? this.jsxParseAttributeValue() : null, this.finishNode(node, "JSXAttribute"));
  }
  jsxParseOpeningElementAt(startLoc) {
    const node = this.startNodeAt(startLoc);
    return this.eat(tt.jsxTagEnd) ? this.finishNode(node, "JSXOpeningFragment") : (node.name = this.jsxParseElementName(), this.jsxParseOpeningElementAfterName(node));
  }
  jsxParseOpeningElementAfterName(node) {
    const attributes = [];
    for (; !this.match(tt.slash) && !this.match(tt.jsxTagEnd); )
      attributes.push(this.jsxParseAttribute());
    return node.attributes = attributes, node.selfClosing = this.eat(tt.slash), this.expect(tt.jsxTagEnd), this.finishNode(node, "JSXOpeningElement");
  }
  jsxParseClosingElementAt(startLoc) {
    const node = this.startNodeAt(startLoc);
    return this.eat(tt.jsxTagEnd) ? this.finishNode(node, "JSXClosingFragment") : (node.name = this.jsxParseElementName(), this.expect(tt.jsxTagEnd), this.finishNode(node, "JSXClosingElement"));
  }
  jsxParseElementAt(startLoc) {
    const node = this.startNodeAt(startLoc), children = [], openingElement = this.jsxParseOpeningElementAt(startLoc);
    let closingElement = null;
    if (!openingElement.selfClosing) {
      contents: for (; ; )
        switch (this.state.type) {
          case tt.jsxTagStart:
            if (startLoc = this.state.startLoc, this.next(), this.eat(tt.slash)) {
              closingElement = this.jsxParseClosingElementAt(startLoc);
              break contents;
            }
            children.push(this.jsxParseElementAt(startLoc));
            break;
          case tt.jsxText:
            children.push(this.parseLiteral(this.state.value, "JSXText"));
            break;
          case tt.braceL: {
            const node2 = this.startNode();
            this.setContext(tc.brace), this.next(), this.match(tt.ellipsis) ? children.push(this.jsxParseSpreadChild(node2)) : children.push(this.jsxParseExpressionContainer(node2, tc.j_expr));
            break;
          }
          default:
            this.unexpected();
        }
      isFragment(openingElement) && !isFragment(closingElement) && closingElement !== null ? this.raise(JsxErrors.MissingClosingTagFragment, closingElement) : !isFragment(openingElement) && isFragment(closingElement) ? this.raise(JsxErrors.MissingClosingTagElement, closingElement, {
        openingTagName: getQualifiedJSXName(openingElement.name)
      }) : !isFragment(openingElement) && !isFragment(closingElement) && getQualifiedJSXName(closingElement.name) !== getQualifiedJSXName(openingElement.name) && this.raise(JsxErrors.MissingClosingTagElement, closingElement, {
        openingTagName: getQualifiedJSXName(openingElement.name)
      });
    }
    if (isFragment(openingElement) ? (node.openingFragment = openingElement, node.closingFragment = closingElement) : (node.openingElement = openingElement, node.closingElement = closingElement), node.children = children, this.match(tt.lt))
      throw this.raise(JsxErrors.UnwrappedAdjacentJSXElements, this.state.startLoc);
    return isFragment(openingElement) ? this.finishNode(node, "JSXFragment") : this.finishNode(node, "JSXElement");
  }
  jsxParseElement() {
    const startLoc = this.state.startLoc;
    return this.next(), this.jsxParseElementAt(startLoc);
  }
  setContext(newContext) {
    const {
      context
    } = this.state;
    context[context.length - 1] = newContext;
  }
  parseExprAtom(refExpressionErrors) {
    return this.match(tt.jsxTagStart) ? this.jsxParseElement() : this.match(tt.lt) && this.input.charCodeAt(this.state.pos) !== 33 ? (this.replaceToken(tt.jsxTagStart), this.jsxParseElement()) : super.parseExprAtom(refExpressionErrors);
  }
  skipSpace() {
    this.curContext().preserveSpace || super.skipSpace();
  }
  getTokenFromCode(code) {
    const context = this.curContext();
    if (context === tc.j_expr) {
      this.jsxReadToken();
      return;
    }
    if (context === tc.j_oTag || context === tc.j_cTag) {
      if (isIdentifierStart(code)) {
        this.jsxReadWord();
        return;
      }
      if (code === 62) {
        ++this.state.pos, this.finishToken(tt.jsxTagEnd);
        return;
      }
      if ((code === 34 || code === 39) && context === tc.j_oTag) {
        this.jsxReadString(code);
        return;
      }
    }
    if (code === 60 && this.state.canStartJSXElement && this.input.charCodeAt(this.state.pos + 1) !== 33) {
      ++this.state.pos, this.finishToken(tt.jsxTagStart);
      return;
    }
    super.getTokenFromCode(code);
  }
  updateContext(prevType) {
    const {
      context,
      type
    } = this.state;
    if (type === tt.slash && prevType === tt.jsxTagStart)
      context.splice(-2, 2, tc.j_cTag), this.state.canStartJSXElement = !1;
    else if (type === tt.jsxTagStart)
      context.push(tc.j_oTag);
    else if (type === tt.jsxTagEnd) {
      const out = context[context.length - 1];
      out === tc.j_oTag && prevType === tt.slash || out === tc.j_cTag ? (context.pop(), this.state.canStartJSXElement = context[context.length - 1] === tc.j_expr) : (this.setContext(tc.j_expr), this.state.canStartJSXElement = !0);
    } else
      this.state.canStartJSXElement = tokenComesBeforeExpression(type);
  }
};
export {
  stdin_default as default
};
