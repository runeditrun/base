// Generated from Babel v7.29.8 (MIT); see README.md.
var _isDigit = function(code) {
  return code >= 48 && code <= 57;
};
const forbiddenNumericSeparatorSiblings = {
  decBinOct: /* @__PURE__ */ new Set([46, 66, 69, 79, 95, 98, 101, 111]),
  hex: /* @__PURE__ */ new Set([46, 88, 95, 120])
}, isAllowedNumericSeparatorSibling = {
  bin: (ch) => ch === 48 || ch === 49,
  oct: (ch) => ch >= 48 && ch <= 55,
  dec: (ch) => ch >= 48 && ch <= 57,
  hex: (ch) => ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102
};
function readStringContents(type, input, pos, lineStart, curLine, errors) {
  const initialPos = pos, initialLineStart = lineStart, initialCurLine = curLine;
  let out = "", firstInvalidLoc = null, chunkStart = pos;
  const {
    length
  } = input;
  for (; ; ) {
    if (pos >= length) {
      errors.unterminated(initialPos, initialLineStart, initialCurLine), out += input.slice(chunkStart, pos);
      break;
    }
    const ch = input.charCodeAt(pos);
    if (isStringEnd(type, ch, input, pos)) {
      out += input.slice(chunkStart, pos);
      break;
    }
    if (ch === 92) {
      out += input.slice(chunkStart, pos);
      const res = readEscapedChar(input, pos, lineStart, curLine, type === "template", errors);
      res.ch === null && !firstInvalidLoc ? firstInvalidLoc = {
        pos,
        lineStart,
        curLine
      } : out += res.ch, {
        pos,
        lineStart,
        curLine
      } = res, chunkStart = pos;
    } else ch === 8232 || ch === 8233 ? (++pos, ++curLine, lineStart = pos) : ch === 10 || ch === 13 ? type === "template" ? (out += input.slice(chunkStart, pos) + `
`, ++pos, ch === 13 && input.charCodeAt(pos) === 10 && ++pos, ++curLine, chunkStart = lineStart = pos) : errors.unterminated(initialPos, initialLineStart, initialCurLine) : ++pos;
  }
  return {
    pos,
    str: out,
    firstInvalidLoc,
    lineStart,
    curLine,
    containsInvalid: !!firstInvalidLoc
  };
}
function isStringEnd(type, ch, input, pos) {
  return type === "template" ? ch === 96 || ch === 36 && input.charCodeAt(pos + 1) === 123 : ch === (type === "double" ? 34 : 39);
}
function readEscapedChar(input, pos, lineStart, curLine, inTemplate, errors) {
  const throwOnInvalid = !inTemplate;
  pos++;
  const res = (ch2) => ({
    pos,
    ch: ch2,
    lineStart,
    curLine
  }), ch = input.charCodeAt(pos++);
  switch (ch) {
    case 110:
      return res(`
`);
    case 114:
      return res("\r");
    case 120: {
      let code;
      return {
        code,
        pos
      } = readHexChar(input, pos, lineStart, curLine, 2, !1, throwOnInvalid, errors), res(code === null ? null : String.fromCharCode(code));
    }
    case 117: {
      let code;
      return {
        code,
        pos
      } = readCodePoint(input, pos, lineStart, curLine, throwOnInvalid, errors), res(code === null ? null : String.fromCodePoint(code));
    }
    case 116:
      return res("	");
    case 98:
      return res("\b");
    case 118:
      return res("\v");
    case 102:
      return res("\f");
    case 13:
      input.charCodeAt(pos) === 10 && ++pos;
    case 10:
      lineStart = pos, ++curLine;
    case 8232:
    case 8233:
      return res("");
    case 56:
    case 57:
      if (inTemplate)
        return res(null);
      errors.strictNumericEscape(pos - 1, lineStart, curLine);
    default:
      if (ch >= 48 && ch <= 55) {
        const startPos = pos - 1;
        let octalStr = /^[0-7]+/.exec(input.slice(startPos, pos + 2))[0], octal = parseInt(octalStr, 8);
        octal > 255 && (octalStr = octalStr.slice(0, -1), octal = parseInt(octalStr, 8)), pos += octalStr.length - 1;
        const next = input.charCodeAt(pos);
        if (octalStr !== "0" || next === 56 || next === 57) {
          if (inTemplate)
            return res(null);
          errors.strictNumericEscape(startPos, lineStart, curLine);
        }
        return res(String.fromCharCode(octal));
      }
      return res(String.fromCharCode(ch));
  }
}
function readHexChar(input, pos, lineStart, curLine, len, forceLen, throwOnInvalid, errors) {
  const initialPos = pos;
  let n;
  return {
    n,
    pos
  } = readInt(input, pos, lineStart, curLine, 16, len, forceLen, !1, errors, !throwOnInvalid), n === null && (throwOnInvalid ? errors.invalidEscapeSequence(initialPos, lineStart, curLine) : pos = initialPos - 1), {
    code: n,
    pos
  };
}
function readInt(input, pos, lineStart, curLine, radix, len, forceLen, allowNumSeparator, errors, bailOnError) {
  const start = pos, forbiddenSiblings = radix === 16 ? forbiddenNumericSeparatorSiblings.hex : forbiddenNumericSeparatorSiblings.decBinOct, isAllowedSibling = radix === 16 ? isAllowedNumericSeparatorSibling.hex : radix === 10 ? isAllowedNumericSeparatorSibling.dec : radix === 8 ? isAllowedNumericSeparatorSibling.oct : isAllowedNumericSeparatorSibling.bin;
  let invalid = !1, total = 0;
  for (let i = 0, e = len ?? 1 / 0; i < e; ++i) {
    const code = input.charCodeAt(pos);
    let val;
    if (code === 95 && allowNumSeparator !== "bail") {
      const prev = input.charCodeAt(pos - 1), next = input.charCodeAt(pos + 1);
      if (allowNumSeparator) {
        if (Number.isNaN(next) || !isAllowedSibling(next) || forbiddenSiblings.has(prev) || forbiddenSiblings.has(next)) {
          if (bailOnError) return {
            n: null,
            pos
          };
          errors.unexpectedNumericSeparator(pos, lineStart, curLine);
        }
      } else {
        if (bailOnError) return {
          n: null,
          pos
        };
        errors.numericSeparatorInEscapeSequence(pos, lineStart, curLine);
      }
      ++pos;
      continue;
    }
    if (code >= 97 ? val = code - 97 + 10 : code >= 65 ? val = code - 65 + 10 : _isDigit(code) ? val = code - 48 : val = 1 / 0, val >= radix) {
      if (val <= 9 && bailOnError)
        return {
          n: null,
          pos
        };
      if (val <= 9 && errors.invalidDigit(pos, lineStart, curLine, radix))
        val = 0;
      else if (forceLen)
        val = 0, invalid = !0;
      else
        break;
    }
    ++pos, total = total * radix + val;
  }
  return pos === start || len != null && pos - start !== len || invalid ? {
    n: null,
    pos
  } : {
    n: total,
    pos
  };
}
function readCodePoint(input, pos, lineStart, curLine, throwOnInvalid, errors) {
  const ch = input.charCodeAt(pos);
  let code;
  if (ch === 123) {
    if (++pos, {
      code,
      pos
    } = readHexChar(input, pos, lineStart, curLine, input.indexOf("}", pos) - pos, !0, throwOnInvalid, errors), ++pos, code !== null && code > 1114111)
      if (throwOnInvalid)
        errors.invalidCodePoint(pos, lineStart, curLine);
      else
        return {
          code: null,
          pos
        };
  } else
    ({
      code,
      pos
    } = readHexChar(input, pos, lineStart, curLine, 4, !1, throwOnInvalid, errors));
  return {
    code,
    pos
  };
}
export {
  readCodePoint,
  readInt,
  readStringContents
};
