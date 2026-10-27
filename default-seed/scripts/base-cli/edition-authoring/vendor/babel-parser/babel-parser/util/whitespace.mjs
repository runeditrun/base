// Generated from Babel v7.29.8 (MIT); see README.md.
const lineBreak = /\r\n|[\r\n\u2028\u2029]/, lineBreakG = new RegExp(lineBreak.source, "g");
function isNewLine(code) {
  switch (code) {
    case 10:
    case 13:
    case 8232:
    case 8233:
      return !0;
    default:
      return !1;
  }
}
function hasNewLine(input, start, end) {
  for (let i = start; i < end; i++)
    if (isNewLine(input.charCodeAt(i)))
      return !0;
  return !1;
}
const skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g, skipWhiteSpaceInLine = /(?:[^\S\n\r\u2028\u2029]|\/\/.*|\/\*.*?\*\/)*/g;
function isWhitespace(code) {
  switch (code) {
    case 9:
    case 11:
    case 12:
    case 32:
    case 160:
    case 5760:
    case 8192:
    case 8193:
    case 8194:
    case 8195:
    case 8196:
    case 8197:
    case 8198:
    case 8199:
    case 8200:
    case 8201:
    case 8202:
    case 8239:
    case 8287:
    case 12288:
    case 65279:
      return !0;
    default:
      return !1;
  }
}
export {
  hasNewLine,
  isNewLine,
  isWhitespace,
  lineBreak,
  lineBreakG,
  skipWhiteSpace,
  skipWhiteSpaceInLine
};
