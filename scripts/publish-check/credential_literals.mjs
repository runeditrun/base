/** Exact credential formats, placeholders and strictly shaped CSS literals for SEC-3. */
const SECRET_PATTERNS=[
 {kind:'PEM private key',regex:/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g},
 {kind:'AWS access key',regex:/\bAKIA[0-9A-Z]{16}\b/g},
 {kind:'GitHub token',regex:/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g},
 {kind:'GitHub fine-grained token',regex:/\bgithub_pat_[A-Za-z0-9_]{22,}/g},
 {kind:'Anthropic key',regex:/\bsk-ant-[A-Za-z0-9_-]{20,}/g},
 {kind:'OpenAI key',regex:/\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g},
 {kind:'Stripe live key',regex:/\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g},
 {kind:'Slack token',regex:/\bxox[abprs]-[A-Za-z0-9-]{10,}/g},
 {kind:'Google API key',regex:/\bAIza[0-9A-Za-z_-]{35}/g},
 {kind:'SendGrid key',regex:/\bSG\.[\w-]{22}\.[\w-]{43}/g},
]

const placeholderMarkers=['example','placeholder','xxxx','test-only','<','${']
// A reader's instruction in place of the value: "your" or "replace with" followed by lowercase words, no digit (your-scoped-deploy-token).
const instruction=/^(?:your|replace[-_]with)(?:[-_][a-z]+)+$/
// A credential variable's name standing for its value: UPPER_SNAKE letters, no digit, ending in what it holds (MAIL_PROVIDER_API_KEY).
const variableName=/^[A-Z]+(?:_[A-Z]+)*_(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY)$/
// Exact credential formats: SEC-1's, plus Stripe test and publishable keys and JWTs, which SEC-3 judges by name.
const exactFormats=[...SECRET_PATTERNS.map(({regex})=>new RegExp(regex.source)),/\b[spr]k_(?:live|test)_[0-9A-Za-z]{8,}/,/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\./]
/** A value carrying an exact credential format is a placeholder only by an explicit marker, and never a fixture, a reference or CSS. */
export function carriesCredential(value) {return exactFormats.some(format=>format.test(value))}
/** Values that are documentation, templates, instructions or a credential variable's name rather than credentials. */
export function isPlaceholder(value) {
 const lower=value.toLowerCase()
 return placeholderMarkers.some(marker=>lower.includes(marker))||!carriesCredential(value)&&(instruction.test(value)||variableName.test(value))
}

// CSS that SEC-3 admits is made only of recognisable CSS shapes; anything else in a literal is judged by the normal rules.
// Identifiers are lowercase letters and single dashes with no digit and numbers have at most four digits either side of the
// point, so no hex, base64, digit or mixed-case run hides in a name, keyword or number.
const cssIdent='-{0,2}[a-z]+(?:-[a-z]+)*'
const cssAtom=`(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[+-]?(?:\\d{1,4}(?:\\.\\d{1,4})?|\\.\\d{1,4})(?:%|px|r?em|ex|ch|[dls]?v[hw]|vmin|vmax|cq[ihw]|fr|deg|rad|turn|m?s|pt|dppx)?|${cssIdent}|"[A-Za-z ]+"|'[A-Za-z ]+'|\x01)`
const cssValue=new RegExp(`^${cssAtom}(?:[\\s,/]+${cssAtom})*(?:!important)?$`)
const cssArguments=new RegExp(`^${cssAtom}(?:(?:[\\s,/*]|\\s[+-]\\s)+${cssAtom})*$`)
const cssFunction=/\b(?:var|calc|min|max|clamp|rgba?|hsla?)\(([^()]*)\)/g
// A compound selector: an optional element, then classes, ids, pseudo-classes and attributes, each with its own sigil.
const cssSubSelector=`(?:[.#]${cssIdent}|::?${cssIdent}|\\[${cssIdent}(?:[~|^$*]?=${cssIdent})?\\]|\x02)`
const cssCompound=`(?:(?:h[1-6]|${cssIdent}|\\*|&)${cssSubSelector}*|${cssSubSelector}+)`
const cssSelector=new RegExp(`^${cssCompound}(?:[\\s,>+~]+${cssCompound})*$`)
const cssPseudoFunction=/:(?:where|is|not|has)\(([^()]*)\)/g
const cssProperty=new RegExp(`^${cssIdent}$`),cssCustomProperty=/^--[a-z]+(?:-[a-z]+)*$/
const cssDeclarations=(text,custom)=>text.split(';').every(declaration=>{
 if(!declaration)return true
 const colon=declaration.indexOf(':')
 return colon>0&&(custom?cssCustomProperty:cssProperty).test(declaration.slice(0,colon))&&cssValue.test(declaration.slice(colon+1))
})
/** A literal written in CSS: custom property declarations (--name:value;…) or selector{declarations} rules, whose every
 * value is a hex colour, a number with unit or %, an identifier, a quoted font name, or var/calc/min/max/clamp/rgb/hsl of those,
 * with at least one value that is not a bare identifier. */
export function cssLiteral(value) {
 if(!/[:{]/.test(value)||/[\x01\x02]/.test(value)||carriesCredential(value)||!/#[0-9a-fA-F]{3}|\d|\b(?:var|calc|min|max|clamp|rgba?|hsla?)\(/.test(value))return false
 let text=value,previous
 do{
  previous=text
  text=text.replace(cssFunction,(whole,args)=>cssArguments.test(args)?'\x01':whole).replace(cssPseudoFunction,(whole,args)=>cssSelector.test(args)?'\x02':whole)
 }while(text!==previous)
 const parts=text.split('}')
 return parts.every((part,index)=>{
  const open=part.indexOf('{')
  // Before any rule: custom properties only (a continued block or a design-token list). Between rules: nothing.
  if(open<0)return index===0?cssDeclarations(part,true):!part
  return part.indexOf('{',open+1)<0&&cssSelector.test(part.slice(0,open))&&cssDeclarations(part.slice(open+1),false)
 })
}
