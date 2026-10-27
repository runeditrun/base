// Generated from Babel v7.29.8 (MIT); see README.md.
import BaseParser from "./base.mjs";
function setTrailingComments(node, comments) {
  node.trailingComments === void 0 ? node.trailingComments = comments : node.trailingComments.unshift(...comments);
}
function setLeadingComments(node, comments) {
  node.leadingComments === void 0 ? node.leadingComments = comments : node.leadingComments.unshift(...comments);
}
function setInnerComments(node, comments) {
  node.innerComments === void 0 ? node.innerComments = comments : node.innerComments.unshift(...comments);
}
function adjustInnerComments(node, elements, commentWS) {
  let lastElement = null, i = elements.length;
  for (; lastElement === null && i > 0; )
    lastElement = elements[--i];
  lastElement === null || lastElement.start > commentWS.start ? setInnerComments(node, commentWS.comments) : setTrailingComments(lastElement, commentWS.comments);
}
class CommentsParser extends BaseParser {
  addComment(comment) {
    this.filename && (comment.loc.filename = this.filename);
    const {
      commentsLen
    } = this.state;
    this.comments.length !== commentsLen && (this.comments.length = commentsLen), this.comments.push(comment), this.state.commentsLen++;
  }
  processComment(node) {
    const {
      commentStack
    } = this.state, commentStackLength = commentStack.length;
    if (commentStackLength === 0) return;
    let i = commentStackLength - 1;
    const lastCommentWS = commentStack[i];
    lastCommentWS.start === node.end && (lastCommentWS.leadingNode = node, i--);
    const {
      start: nodeStart
    } = node;
    for (; i >= 0; i--) {
      const commentWS = commentStack[i], commentEnd = commentWS.end;
      if (commentEnd > nodeStart)
        commentWS.containingNode = node, this.finalizeComment(commentWS), commentStack.splice(i, 1);
      else {
        commentEnd === nodeStart && (commentWS.trailingNode = node);
        break;
      }
    }
  }
  finalizeComment(commentWS) {
    const {
      comments
    } = commentWS;
    if (commentWS.leadingNode !== null || commentWS.trailingNode !== null)
      commentWS.leadingNode !== null && setTrailingComments(commentWS.leadingNode, comments), commentWS.trailingNode !== null && setLeadingComments(commentWS.trailingNode, comments);
    else {
      const node = commentWS.containingNode, commentStart = commentWS.start;
      if (this.input.charCodeAt(this.offsetToSourcePos(commentStart) - 1) === 44)
        switch (node.type) {
          case "ObjectExpression":
          case "ObjectPattern":
            adjustInnerComments(node, node.properties, commentWS);
            break;
          case "CallExpression":
          case "NewExpression":
          case "OptionalCallExpression":
            adjustInnerComments(node, node.arguments, commentWS);
            break;
          case "ImportExpression":
            adjustInnerComments(node, [node.source, node.options ?? null], commentWS);
            break;
          case "FunctionDeclaration":
          case "FunctionExpression":
          case "ArrowFunctionExpression":
          case "ObjectMethod":
          case "ClassMethod":
          case "ClassPrivateMethod":
          case "TSTypeParameterDeclaration":
            adjustInnerComments(node, node.params, commentWS);
            break;
          case "ArrayExpression":
          case "ArrayPattern":
            adjustInnerComments(node, node.elements, commentWS);
            break;
          case "ExportNamedDeclaration":
          case "ImportDeclaration":
            adjustInnerComments(node, node.specifiers, commentWS);
            break;
          case "TSEnumDeclaration":
            adjustInnerComments(node, node.members, commentWS);
            break;
          case "TSEnumBody":
            adjustInnerComments(node, node.members, commentWS);
            break;
          case "TSInterfaceBody":
            adjustInnerComments(node, node.body, commentWS);
            break;
          default: {
            if (node.type === "RecordExpression") {
              adjustInnerComments(node, node.properties, commentWS);
              break;
            }
            if (node.type === "TupleExpression") {
              adjustInnerComments(node, node.elements, commentWS);
              break;
            }
            setInnerComments(node, comments);
          }
        }
      else
        setInnerComments(node, comments);
    }
  }
  finalizeRemainingComments() {
    const {
      commentStack
    } = this.state;
    for (let i = commentStack.length - 1; i >= 0; i--)
      this.finalizeComment(commentStack[i]);
    this.state.commentStack = [];
  }
  resetPreviousNodeTrailingComments(node) {
    const {
      commentStack
    } = this.state, {
      length
    } = commentStack;
    if (length === 0) return;
    const commentWS = commentStack[length - 1];
    commentWS.leadingNode === node && (commentWS.leadingNode = null);
  }
  takeSurroundingComments(node, start, end) {
    const {
      commentStack
    } = this.state, commentStackLength = commentStack.length;
    if (commentStackLength === 0) return;
    let i = commentStackLength - 1;
    for (; i >= 0; i--) {
      const commentWS = commentStack[i], commentEnd = commentWS.end;
      if (commentWS.start === end)
        commentWS.leadingNode = node;
      else if (commentEnd === start)
        commentWS.trailingNode = node;
      else if (commentEnd < start)
        break;
    }
  }
}
export {
  CommentsParser as default,
  setInnerComments
};
