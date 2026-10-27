// Generated from Babel v7.29.8 (MIT); see README.md.
import { OptionFlags } from "../options.mjs";
import { Position, SourceLocation, createPositionWithColumnOffset } from "../util/location.mjs";
import CommentsParser from "../parser/comments.mjs";
import { isIdentifierStart, isIdentifierChar } from "../util/identifier.mjs";
import { tokenIsKeyword, tokenLabelName, tt, keywords as keywordTypes } from "./types.mjs";
import { Errors } from "../parse-error.mjs";
import { lineBreakG, isNewLine, isWhitespace, skipWhiteSpace, skipWhiteSpaceInLine } from "../util/whitespace.mjs";
import State from "./state.mjs";
import { readInt, readCodePoint, readStringContents } from "../../babel-helper-string-parser/index.mjs";
function buildPosition(pos, lineStart, curLine) {
  return new Position(curLine, pos - lineStart, pos);
}
const VALID_REGEX_FLAGS = /* @__PURE__ */ new Set([103, 109, 115, 105, 121, 117, 100, 118]);
class Token {
  constructor(state) {
    const startIndex = state.startIndex || 0;
    this.type = state.type, this.value = state.value, this.start = startIndex + state.start, this.end = startIndex + state.end, this.loc = new SourceLocation(state.startLoc, state.endLoc);
  }
}
class Tokenizer extends CommentsParser {
  isLookahead;
  tokens = [];
  constructor(options, input) {
    super(), this.state = new State(), this.state.init(options), this.input = input, this.length = input.length, this.comments = [], this.isLookahead = !1;
  }
  pushToken(token) {
    this.tokens.length = this.state.tokensLength, this.tokens.push(token), ++this.state.tokensLength;
  }
  next() {
    this.checkKeywordEscapes(), this.optionFlags & OptionFlags.Tokens && this.pushToken(new Token(this.state)), this.state.lastTokEndLoc = this.state.endLoc, this.state.lastTokStartLoc = this.state.startLoc, this.nextToken();
  }
  eat(type) {
    return this.match(type) ? (this.next(), !0) : !1;
  }
  match(type) {
    return this.state.type === type;
  }
  createLookaheadState(state) {
    return {
      pos: state.pos,
      value: null,
      type: state.type,
      start: state.start,
      end: state.end,
      context: [this.curContext()],
      inType: state.inType,
      startLoc: state.startLoc,
      lastTokEndLoc: state.lastTokEndLoc,
      curLine: state.curLine,
      lineStart: state.lineStart,
      curPosition: state.curPosition
    };
  }
  lookahead() {
    const old = this.state;
    this.state = this.createLookaheadState(old), this.isLookahead = !0, this.nextToken(), this.isLookahead = !1;
    const curr = this.state;
    return this.state = old, curr;
  }
  nextTokenStart() {
    return this.nextTokenStartSince(this.state.pos);
  }
  nextTokenStartSince(pos) {
    return skipWhiteSpace.lastIndex = pos, skipWhiteSpace.test(this.input) ? skipWhiteSpace.lastIndex : pos;
  }
  lookaheadCharCode() {
    return this.lookaheadCharCodeSince(this.state.pos);
  }
  lookaheadCharCodeSince(pos) {
    return this.input.charCodeAt(this.nextTokenStartSince(pos));
  }
  nextTokenInLineStart() {
    return this.nextTokenInLineStartSince(this.state.pos);
  }
  nextTokenInLineStartSince(pos) {
    return skipWhiteSpaceInLine.lastIndex = pos, skipWhiteSpaceInLine.test(this.input) ? skipWhiteSpaceInLine.lastIndex : pos;
  }
  lookaheadInLineCharCode() {
    return this.input.charCodeAt(this.nextTokenInLineStart());
  }
  codePointAtPos(pos) {
    let cp = this.input.charCodeAt(pos);
    if ((cp & 64512) === 55296 && ++pos < this.input.length) {
      const trail = this.input.charCodeAt(pos);
      (trail & 64512) === 56320 && (cp = 65536 + ((cp & 1023) << 10) + (trail & 1023));
    }
    return cp;
  }
  setStrict(strict) {
    this.state.strict = strict, strict && (this.state.strictErrors.forEach(([toParseError, at]) => this.raise(toParseError, at)), this.state.strictErrors.clear());
  }
  curContext() {
    return this.state.context[this.state.context.length - 1];
  }
  nextToken() {
    if (this.skipSpace(), this.state.start = this.state.pos, this.isLookahead || (this.state.startLoc = this.state.curPosition()), this.state.pos >= this.length) {
      this.finishToken(tt.eof);
      return;
    }
    this.getTokenFromCode(this.codePointAtPos(this.state.pos));
  }
  skipBlockComment(commentEnd) {
    let startLoc;
    this.isLookahead || (startLoc = this.state.curPosition());
    const start = this.state.pos, end = this.input.indexOf(commentEnd, start + 2);
    if (end === -1)
      throw this.raise(Errors.UnterminatedComment, this.state.curPosition());
    for (this.state.pos = end + commentEnd.length, lineBreakG.lastIndex = start + 2; lineBreakG.test(this.input) && lineBreakG.lastIndex <= end; )
      ++this.state.curLine, this.state.lineStart = lineBreakG.lastIndex;
    if (this.isLookahead) return;
    const comment = {
      type: "CommentBlock",
      value: this.input.slice(start + 2, end),
      start: this.sourceToOffsetPos(start),
      end: this.sourceToOffsetPos(end + commentEnd.length),
      loc: new SourceLocation(startLoc, this.state.curPosition())
    };
    return this.optionFlags & OptionFlags.Tokens && this.pushToken(comment), comment;
  }
  skipLineComment(startSkip) {
    const start = this.state.pos;
    let startLoc;
    this.isLookahead || (startLoc = this.state.curPosition());
    let ch = this.input.charCodeAt(this.state.pos += startSkip);
    if (this.state.pos < this.length)
      for (; !isNewLine(ch) && ++this.state.pos < this.length; )
        ch = this.input.charCodeAt(this.state.pos);
    if (this.isLookahead) return;
    const end = this.state.pos, comment = {
      type: "CommentLine",
      value: this.input.slice(start + startSkip, end),
      start: this.sourceToOffsetPos(start),
      end: this.sourceToOffsetPos(end),
      loc: new SourceLocation(startLoc, this.state.curPosition())
    };
    return this.optionFlags & OptionFlags.Tokens && this.pushToken(comment), comment;
  }
  skipSpace() {
    const spaceStart = this.state.pos, comments = this.optionFlags & OptionFlags.AttachComment ? [] : null;
    loop: for (; this.state.pos < this.length; ) {
      const ch = this.input.charCodeAt(this.state.pos);
      switch (ch) {
        case 32:
        case 160:
        case 9:
          ++this.state.pos;
          break;
        case 13:
          this.input.charCodeAt(this.state.pos + 1) === 10 && ++this.state.pos;
        case 10:
        case 8232:
        case 8233:
          ++this.state.pos, ++this.state.curLine, this.state.lineStart = this.state.pos;
          break;
        case 47:
          switch (this.input.charCodeAt(this.state.pos + 1)) {
            case 42: {
              const comment = this.skipBlockComment("*/");
              comment !== void 0 && (this.addComment(comment), comments?.push(comment));
              break;
            }
            case 47: {
              const comment = this.skipLineComment(2);
              comment !== void 0 && (this.addComment(comment), comments?.push(comment));
              break;
            }
            default:
              break loop;
          }
          break;
        default:
          if (isWhitespace(ch))
            ++this.state.pos;
          else if (ch === 45 && !this.inModule && this.optionFlags & OptionFlags.AnnexB) {
            const pos = this.state.pos;
            if (this.input.charCodeAt(pos + 1) === 45 && this.input.charCodeAt(pos + 2) === 62 && (spaceStart === 0 || this.state.lineStart > spaceStart)) {
              const comment = this.skipLineComment(3);
              comment !== void 0 && (this.addComment(comment), comments?.push(comment));
            } else
              break loop;
          } else if (ch === 60 && !this.inModule && this.optionFlags & OptionFlags.AnnexB) {
            const pos = this.state.pos;
            if (this.input.charCodeAt(pos + 1) === 33 && this.input.charCodeAt(pos + 2) === 45 && this.input.charCodeAt(pos + 3) === 45) {
              const comment = this.skipLineComment(4);
              comment !== void 0 && (this.addComment(comment), comments?.push(comment));
            } else
              break loop;
          } else
            break loop;
      }
    }
    if (comments?.length > 0) {
      const end = this.state.pos, commentWhitespace = {
        start: this.sourceToOffsetPos(spaceStart),
        end: this.sourceToOffsetPos(end),
        comments,
        leadingNode: null,
        trailingNode: null,
        containingNode: null
      };
      this.state.commentStack.push(commentWhitespace);
    }
  }
  finishToken(type, val) {
    this.state.end = this.state.pos, this.state.endLoc = this.state.curPosition();
    const prevType = this.state.type;
    this.state.type = type, this.state.value = val, this.isLookahead || this.updateContext(prevType);
  }
  replaceToken(type) {
    this.state.type = type, this.updateContext();
  }
  readToken_numberSign() {
    if (this.state.pos === 0 && this.readToken_interpreter())
      return;
    const nextPos = this.state.pos + 1, next = this.codePointAtPos(nextPos);
    if (next >= 48 && next <= 57)
      throw this.raise(Errors.UnexpectedDigitAfterHash, this.state.curPosition());
    if (next === 123 || next === 91 && this.hasPlugin("recordAndTuple")) {
      if (this.expectPlugin("recordAndTuple"), this.getPluginOption("recordAndTuple", "syntaxType") === "bar")
        throw this.raise(next === 123 ? Errors.RecordExpressionHashIncorrectStartSyntaxType : Errors.TupleExpressionHashIncorrectStartSyntaxType, this.state.curPosition());
      this.state.pos += 2, next === 123 ? this.finishToken(tt.braceHashL) : this.finishToken(tt.bracketHashL);
    } else isIdentifierStart(next) ? (++this.state.pos, this.finishToken(tt.privateName, this.readWord1(next))) : next === 92 ? (++this.state.pos, this.finishToken(tt.privateName, this.readWord1())) : this.finishOp(tt.hash, 1);
  }
  readToken_dot() {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next >= 48 && next <= 57) {
      this.readNumber(!0);
      return;
    }
    next === 46 && this.input.charCodeAt(this.state.pos + 2) === 46 ? (this.state.pos += 3, this.finishToken(tt.ellipsis)) : (++this.state.pos, this.finishToken(tt.dot));
  }
  readToken_slash() {
    this.input.charCodeAt(this.state.pos + 1) === 61 ? this.finishOp(tt.slashAssign, 2) : this.finishOp(tt.slash, 1);
  }
  readToken_interpreter() {
    if (this.state.pos !== 0 || this.length < 2) return !1;
    let ch = this.input.charCodeAt(this.state.pos + 1);
    if (ch !== 33) return !1;
    const start = this.state.pos;
    for (this.state.pos += 1; !isNewLine(ch) && ++this.state.pos < this.length; )
      ch = this.input.charCodeAt(this.state.pos);
    const value = this.input.slice(start + 2, this.state.pos);
    return this.finishToken(tt.interpreterDirective, value), !0;
  }
  readToken_mult_modulo(code) {
    let type = code === 42 ? tt.star : tt.modulo, width = 1, next = this.input.charCodeAt(this.state.pos + 1);
    code === 42 && next === 42 && (width++, next = this.input.charCodeAt(this.state.pos + 2), type = tt.exponent), next === 61 && !this.state.inType && (width++, type = code === 37 ? tt.moduloAssign : tt.assign), this.finishOp(type, width);
  }
  readToken_pipe_amp(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next === code) {
      this.input.charCodeAt(this.state.pos + 2) === 61 ? this.finishOp(tt.assign, 3) : this.finishOp(code === 124 ? tt.logicalOR : tt.logicalAND, 2);
      return;
    }
    if (code === 124) {
      if (next === 62) {
        this.finishOp(tt.pipeline, 2);
        return;
      }
      if (this.hasPlugin("recordAndTuple") && next === 125) {
        if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar")
          throw this.raise(Errors.RecordExpressionBarIncorrectEndSyntaxType, this.state.curPosition());
        this.state.pos += 2, this.finishToken(tt.braceBarR);
        return;
      }
      if (this.hasPlugin("recordAndTuple") && next === 93) {
        if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar")
          throw this.raise(Errors.TupleExpressionBarIncorrectEndSyntaxType, this.state.curPosition());
        this.state.pos += 2, this.finishToken(tt.bracketBarR);
        return;
      }
    }
    if (next === 61) {
      this.finishOp(tt.assign, 2);
      return;
    }
    this.finishOp(code === 124 ? tt.bitwiseOR : tt.bitwiseAND, 1);
  }
  readToken_caret() {
    const next = this.input.charCodeAt(this.state.pos + 1);
    next === 61 && !this.state.inType ? this.finishOp(tt.xorAssign, 2) : next === 94 && this.hasPlugin(["pipelineOperator", {
      proposal: "hack",
      topicToken: "^^"
    }]) ? (this.finishOp(tt.doubleCaret, 2), this.input.codePointAt(this.state.pos) === 94 && this.unexpected()) : this.finishOp(tt.bitwiseXOR, 1);
  }
  readToken_atSign() {
    this.input.charCodeAt(this.state.pos + 1) === 64 && this.hasPlugin(["pipelineOperator", {
      proposal: "hack",
      topicToken: "@@"
    }]) ? this.finishOp(tt.doubleAt, 2) : this.finishOp(tt.at, 1);
  }
  readToken_plus_min(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next === code) {
      this.finishOp(tt.incDec, 2);
      return;
    }
    next === 61 ? this.finishOp(tt.assign, 2) : this.finishOp(tt.plusMin, 1);
  }
  readToken_lt() {
    const {
      pos
    } = this.state, next = this.input.charCodeAt(pos + 1);
    if (next === 60) {
      if (this.input.charCodeAt(pos + 2) === 61) {
        this.finishOp(tt.assign, 3);
        return;
      }
      this.finishOp(tt.bitShiftL, 2);
      return;
    }
    if (next === 61) {
      this.finishOp(tt.relational, 2);
      return;
    }
    this.finishOp(tt.lt, 1);
  }
  readToken_gt() {
    const {
      pos
    } = this.state, next = this.input.charCodeAt(pos + 1);
    if (next === 62) {
      const size = this.input.charCodeAt(pos + 2) === 62 ? 3 : 2;
      if (this.input.charCodeAt(pos + size) === 61) {
        this.finishOp(tt.assign, size + 1);
        return;
      }
      this.finishOp(tt.bitShiftR, size);
      return;
    }
    if (next === 61) {
      this.finishOp(tt.relational, 2);
      return;
    }
    this.finishOp(tt.gt, 1);
  }
  readToken_eq_excl(code) {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next === 61) {
      this.finishOp(tt.equality, this.input.charCodeAt(this.state.pos + 2) === 61 ? 3 : 2);
      return;
    }
    if (code === 61 && next === 62) {
      this.state.pos += 2, this.finishToken(tt.arrow);
      return;
    }
    this.finishOp(code === 61 ? tt.eq : tt.bang, 1);
  }
  readToken_question() {
    const next = this.input.charCodeAt(this.state.pos + 1), next2 = this.input.charCodeAt(this.state.pos + 2);
    next === 63 ? next2 === 61 ? this.finishOp(tt.assign, 3) : this.finishOp(tt.nullishCoalescing, 2) : next === 46 && !(next2 >= 48 && next2 <= 57) ? (this.state.pos += 2, this.finishToken(tt.questionDot)) : (++this.state.pos, this.finishToken(tt.question));
  }
  getTokenFromCode(code) {
    switch (code) {
      case 46:
        this.readToken_dot();
        return;
      case 40:
        ++this.state.pos, this.finishToken(tt.parenL);
        return;
      case 41:
        ++this.state.pos, this.finishToken(tt.parenR);
        return;
      case 59:
        ++this.state.pos, this.finishToken(tt.semi);
        return;
      case 44:
        ++this.state.pos, this.finishToken(tt.comma);
        return;
      case 91:
        if (this.hasPlugin("recordAndTuple") && this.input.charCodeAt(this.state.pos + 1) === 124) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar")
            throw this.raise(Errors.TupleExpressionBarIncorrectStartSyntaxType, this.state.curPosition());
          this.state.pos += 2, this.finishToken(tt.bracketBarL);
        } else
          ++this.state.pos, this.finishToken(tt.bracketL);
        return;
      case 93:
        ++this.state.pos, this.finishToken(tt.bracketR);
        return;
      case 123:
        if (this.hasPlugin("recordAndTuple") && this.input.charCodeAt(this.state.pos + 1) === 124) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar")
            throw this.raise(Errors.RecordExpressionBarIncorrectStartSyntaxType, this.state.curPosition());
          this.state.pos += 2, this.finishToken(tt.braceBarL);
        } else
          ++this.state.pos, this.finishToken(tt.braceL);
        return;
      case 125:
        ++this.state.pos, this.finishToken(tt.braceR);
        return;
      case 58:
        this.hasPlugin("functionBind") && this.input.charCodeAt(this.state.pos + 1) === 58 ? this.finishOp(tt.doubleColon, 2) : (++this.state.pos, this.finishToken(tt.colon));
        return;
      case 63:
        this.readToken_question();
        return;
      case 96:
        this.readTemplateToken();
        return;
      case 48: {
        const next = this.input.charCodeAt(this.state.pos + 1);
        if (next === 120 || next === 88) {
          this.readRadixNumber(16);
          return;
        }
        if (next === 111 || next === 79) {
          this.readRadixNumber(8);
          return;
        }
        if (next === 98 || next === 66) {
          this.readRadixNumber(2);
          return;
        }
      }
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        this.readNumber(!1);
        return;
      case 34:
      case 39:
        this.readString(code);
        return;
      case 47:
        this.readToken_slash();
        return;
      case 37:
      case 42:
        this.readToken_mult_modulo(code);
        return;
      case 124:
      case 38:
        this.readToken_pipe_amp(code);
        return;
      case 94:
        this.readToken_caret();
        return;
      case 43:
      case 45:
        this.readToken_plus_min(code);
        return;
      case 60:
        this.readToken_lt();
        return;
      case 62:
        this.readToken_gt();
        return;
      case 61:
      case 33:
        this.readToken_eq_excl(code);
        return;
      case 126:
        this.finishOp(tt.tilde, 1);
        return;
      case 64:
        this.readToken_atSign();
        return;
      case 35:
        this.readToken_numberSign();
        return;
      case 92:
        this.readWord();
        return;
      default:
        if (isIdentifierStart(code)) {
          this.readWord(code);
          return;
        }
    }
    throw this.raise(Errors.InvalidOrUnexpectedToken, this.state.curPosition(), {
      unexpected: String.fromCodePoint(code)
    });
  }
  finishOp(type, size) {
    const str = this.input.slice(this.state.pos, this.state.pos + size);
    this.state.pos += size, this.finishToken(type, str);
  }
  readRegexp() {
    const startLoc = this.state.startLoc, start = this.state.start + 1;
    let escaped, inClass, {
      pos
    } = this.state;
    for (; ; ++pos) {
      if (pos >= this.length)
        throw this.raise(Errors.UnterminatedRegExp, createPositionWithColumnOffset(startLoc, 1));
      const ch = this.input.charCodeAt(pos);
      if (isNewLine(ch))
        throw this.raise(Errors.UnterminatedRegExp, createPositionWithColumnOffset(startLoc, 1));
      if (escaped)
        escaped = !1;
      else {
        if (ch === 91)
          inClass = !0;
        else if (ch === 93 && inClass)
          inClass = !1;
        else if (ch === 47 && !inClass)
          break;
        escaped = ch === 92;
      }
    }
    const content = this.input.slice(start, pos);
    ++pos;
    let mods = "";
    const nextPos = () => createPositionWithColumnOffset(startLoc, pos + 2 - start);
    for (; pos < this.length; ) {
      const cp = this.codePointAtPos(pos), char = String.fromCharCode(cp);
      if (VALID_REGEX_FLAGS.has(cp))
        cp === 118 ? mods.includes("u") && this.raise(Errors.IncompatibleRegExpUVFlags, nextPos()) : cp === 117 && mods.includes("v") && this.raise(Errors.IncompatibleRegExpUVFlags, nextPos()), mods.includes(char) && this.raise(Errors.DuplicateRegExpFlags, nextPos());
      else if (isIdentifierChar(cp) || cp === 92)
        this.raise(Errors.MalformedRegExpFlags, nextPos());
      else
        break;
      ++pos, mods += char;
    }
    this.state.pos = pos, this.finishToken(tt.regexp, {
      pattern: content,
      flags: mods
    });
  }
  readInt(radix, len, forceLen = !1, allowNumSeparator = !0) {
    const {
      n,
      pos
    } = readInt(this.input, this.state.pos, this.state.lineStart, this.state.curLine, radix, len, forceLen, allowNumSeparator, this.errorHandlers_readInt, !1);
    return this.state.pos = pos, n;
  }
  readRadixNumber(radix) {
    const start = this.state.pos, startLoc = this.state.curPosition();
    let isBigInt = !1;
    this.state.pos += 2;
    const val = this.readInt(radix);
    val == null && this.raise(Errors.InvalidDigit, createPositionWithColumnOffset(startLoc, 2), {
      radix
    });
    const next = this.input.charCodeAt(this.state.pos);
    if (next === 110)
      ++this.state.pos, isBigInt = !0;
    else if (next === 109)
      throw this.raise(Errors.InvalidDecimal, startLoc);
    if (isIdentifierStart(this.codePointAtPos(this.state.pos)))
      throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
    if (isBigInt) {
      const str = this.input.slice(start, this.state.pos).replace(/[_n]/g, "");
      this.finishToken(tt.bigint, str);
      return;
    }
    this.finishToken(tt.num, val);
  }
  readNumber(startsWithDot) {
    const start = this.state.pos, startLoc = this.state.curPosition();
    let isFloat = !1, isBigInt = !1, hasExponent = !1, isOctal = !1;
    !startsWithDot && this.readInt(10) === null && this.raise(Errors.InvalidNumber, this.state.curPosition());
    const hasLeadingZero = this.state.pos - start >= 2 && this.input.charCodeAt(start) === 48;
    if (hasLeadingZero) {
      const integer = this.input.slice(start, this.state.pos);
      if (this.recordStrictModeErrors(Errors.StrictOctalLiteral, startLoc), !this.state.strict) {
        const underscorePos = integer.indexOf("_");
        underscorePos > 0 && this.raise(Errors.ZeroDigitNumericSeparator, createPositionWithColumnOffset(startLoc, underscorePos));
      }
      isOctal = hasLeadingZero && !/[89]/.test(integer);
    }
    let next = this.input.charCodeAt(this.state.pos);
    if (next === 46 && !isOctal && (++this.state.pos, this.readInt(10), isFloat = !0, next = this.input.charCodeAt(this.state.pos)), (next === 69 || next === 101) && !isOctal && (next = this.input.charCodeAt(++this.state.pos), (next === 43 || next === 45) && ++this.state.pos, this.readInt(10) === null && this.raise(Errors.InvalidOrMissingExponent, startLoc), isFloat = !0, hasExponent = !0, next = this.input.charCodeAt(this.state.pos)), next === 110 && ((isFloat || hasLeadingZero) && this.raise(Errors.InvalidBigIntLiteral, startLoc), ++this.state.pos, isBigInt = !0), next === 109) {
      this.expectPlugin("decimal", this.state.curPosition()), (hasExponent || hasLeadingZero) && this.raise(Errors.InvalidDecimal, startLoc), ++this.state.pos;
      var isDecimal = !0;
    }
    if (isIdentifierStart(this.codePointAtPos(this.state.pos)))
      throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
    const str = this.input.slice(start, this.state.pos).replace(/[_mn]/g, "");
    if (isBigInt) {
      this.finishToken(tt.bigint, str);
      return;
    }
    if (isDecimal) {
      this.finishToken(tt.decimal, str);
      return;
    }
    const val = isOctal ? parseInt(str, 8) : parseFloat(str);
    this.finishToken(tt.num, val);
  }
  readCodePoint(throwOnInvalid) {
    const {
      code,
      pos
    } = readCodePoint(this.input, this.state.pos, this.state.lineStart, this.state.curLine, throwOnInvalid, this.errorHandlers_readCodePoint);
    return this.state.pos = pos, code;
  }
  readString(quote) {
    const {
      str,
      pos,
      curLine,
      lineStart
    } = readStringContents(quote === 34 ? "double" : "single", this.input, this.state.pos + 1, this.state.lineStart, this.state.curLine, this.errorHandlers_readStringContents_string);
    this.state.pos = pos + 1, this.state.lineStart = lineStart, this.state.curLine = curLine, this.finishToken(tt.string, str);
  }
  readTemplateContinuation() {
    this.match(tt.braceR) || this.unexpected(null, tt.braceR), this.state.pos--, this.readTemplateToken();
  }
  readTemplateToken() {
    const opening = this.input[this.state.pos], {
      str,
      firstInvalidLoc,
      pos,
      curLine,
      lineStart
    } = readStringContents("template", this.input, this.state.pos + 1, this.state.lineStart, this.state.curLine, this.errorHandlers_readStringContents_template);
    this.state.pos = pos + 1, this.state.lineStart = lineStart, this.state.curLine = curLine, firstInvalidLoc && (this.state.firstInvalidTemplateEscapePos = new Position(firstInvalidLoc.curLine, firstInvalidLoc.pos - firstInvalidLoc.lineStart, this.sourceToOffsetPos(firstInvalidLoc.pos))), this.input.codePointAt(pos) === 96 ? this.finishToken(tt.templateTail, firstInvalidLoc ? null : opening + str + "`") : (this.state.pos++, this.finishToken(tt.templateNonTail, firstInvalidLoc ? null : opening + str + "${"));
  }
  recordStrictModeErrors(toParseError, at) {
    const index = at.index;
    this.state.strict && !this.state.strictErrors.has(index) ? this.raise(toParseError, at) : this.state.strictErrors.set(index, [toParseError, at]);
  }
  readWord1(firstCode) {
    this.state.containsEsc = !1;
    let word = "";
    const start = this.state.pos;
    let chunkStart = this.state.pos;
    for (firstCode !== void 0 && (this.state.pos += firstCode <= 65535 ? 1 : 2); this.state.pos < this.length; ) {
      const ch = this.codePointAtPos(this.state.pos);
      if (isIdentifierChar(ch))
        this.state.pos += ch <= 65535 ? 1 : 2;
      else if (ch === 92) {
        this.state.containsEsc = !0, word += this.input.slice(chunkStart, this.state.pos);
        const escStart = this.state.curPosition(), identifierCheck = this.state.pos === start ? isIdentifierStart : isIdentifierChar;
        if (this.input.charCodeAt(++this.state.pos) !== 117) {
          this.raise(Errors.MissingUnicodeEscape, this.state.curPosition()), chunkStart = this.state.pos - 1;
          continue;
        }
        ++this.state.pos;
        const esc = this.readCodePoint(!0);
        esc !== null && (identifierCheck(esc) || this.raise(Errors.EscapedCharNotAnIdentifier, escStart), word += String.fromCodePoint(esc)), chunkStart = this.state.pos;
      } else
        break;
    }
    return word + this.input.slice(chunkStart, this.state.pos);
  }
  readWord(firstCode) {
    const word = this.readWord1(firstCode), type = keywordTypes.get(word);
    type !== void 0 ? this.finishToken(type, tokenLabelName(type)) : this.finishToken(tt.name, word);
  }
  checkKeywordEscapes() {
    const {
      type
    } = this.state;
    tokenIsKeyword(type) && this.state.containsEsc && this.raise(Errors.InvalidEscapedReservedWord, this.state.startLoc, {
      reservedWord: tokenLabelName(type)
    });
  }
  raise(toParseError, at, details = {}) {
    const loc = at instanceof Position ? at : at.loc.start, error = toParseError(loc, details);
    if (!(this.optionFlags & OptionFlags.ErrorRecovery)) throw error;
    return this.isLookahead || this.state.errors.push(error), error;
  }
  raiseOverwrite(toParseError, at, details = {}) {
    const loc = at instanceof Position ? at : at.loc.start, pos = loc.index, errors = this.state.errors;
    for (let i = errors.length - 1; i >= 0; i--) {
      const error = errors[i];
      if (error.loc.index === pos)
        return errors[i] = toParseError(loc, details);
      if (error.loc.index < pos) break;
    }
    return this.raise(toParseError, at, details);
  }
  updateContext(prevType) {
  }
  unexpected(loc, type) {
    throw this.raise(Errors.UnexpectedToken, loc ?? this.state.startLoc, {
      expected: type ? tokenLabelName(type) : null
    });
  }
  expectPlugin(pluginName, loc) {
    if (this.hasPlugin(pluginName))
      return !0;
    throw this.raise(Errors.MissingPlugin, loc ?? this.state.startLoc, {
      missingPlugin: [pluginName]
    });
  }
  expectOnePlugin(pluginNames) {
    if (!pluginNames.some((name) => this.hasPlugin(name)))
      throw this.raise(Errors.MissingOneOfPlugins, this.state.startLoc, {
        missingPlugin: pluginNames
      });
  }
  errorBuilder(error) {
    return (pos, lineStart, curLine) => {
      this.raise(error, buildPosition(pos, lineStart, curLine));
    };
  }
  errorHandlers_readInt = {
    invalidDigit: (pos, lineStart, curLine, radix) => this.optionFlags & OptionFlags.ErrorRecovery ? (this.raise(Errors.InvalidDigit, buildPosition(pos, lineStart, curLine), {
      radix
    }), !0) : !1,
    numericSeparatorInEscapeSequence: this.errorBuilder(Errors.NumericSeparatorInEscapeSequence),
    unexpectedNumericSeparator: this.errorBuilder(Errors.UnexpectedNumericSeparator)
  };
  errorHandlers_readCodePoint = {
    ...this.errorHandlers_readInt,
    invalidEscapeSequence: this.errorBuilder(Errors.InvalidEscapeSequence),
    invalidCodePoint: this.errorBuilder(Errors.InvalidCodePoint)
  };
  errorHandlers_readStringContents_string = {
    ...this.errorHandlers_readCodePoint,
    strictNumericEscape: (pos, lineStart, curLine) => {
      this.recordStrictModeErrors(Errors.StrictNumericEscape, buildPosition(pos, lineStart, curLine));
    },
    unterminated: (pos, lineStart, curLine) => {
      throw this.raise(Errors.UnterminatedString, buildPosition(pos - 1, lineStart, curLine));
    }
  };
  errorHandlers_readStringContents_template = {
    ...this.errorHandlers_readCodePoint,
    strictNumericEscape: this.errorBuilder(Errors.StrictNumericEscape),
    unterminated: (pos, lineStart, curLine) => {
      throw this.raise(Errors.UnterminatedTemplate, buildPosition(pos, lineStart, curLine));
    }
  };
}
export {
  Token,
  Tokenizer as default
};
