/** SEC-3 credential assignment: literal syntax, entropy and fixture/reference semantics. */
import {codeSource, typeDeclarations} from './credential_syntax.mjs';
import {carriesCredential, isPlaceholder, cssLiteral} from './credential_literals.mjs';

function shannonEntropy(value) {
 const counts = new Map();
 for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
 const length = [...value].length;
 let entropy = 0;
 for (const count of counts.values()) { const p = count / length; entropy -= p * Math.log2(p); }
 return entropy;
}
// Bounded name parts keep matching linear on long lines (no unbounded backtracking before the keyword).
const assignment=/(?<![A-Za-z0-9_.$-])([A-Za-z0-9_.$-]{0,48}(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,48})["'\]]?[ \t]{0,8}(?::=|:|=)[ \t\r\n]{0,8}(["'`])([^"'`\s]{16,512})\2/gi
// Unquoted source identifiers and expressions are references, never literal credential values.
const numberAssignment=/(?<![A-Za-z0-9_.$-])([A-Za-z0-9_.$-]{0,48}(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,48})[ \t]{0,8}(?::=|:|=)[ \t]{0,8}([+-]?(?:0x[\da-f]{16,512}|\d{16,512}))(?![\w.$])/gi


function parameterType(text,match){
 // A colon directly after a parameter name describes its type. Defaults use '=' and still scan.
 const afterName=match[0].slice(match[1].length)
 return /^[ \t]*:/.test(afterName)&&/(?:^|[,(])[ \t\r\n]*$/.test(text.slice(Math.max(0,match.index -256),match.index))
}

const envAssignment=/^[ \t]{0,8}(?:export[ \t]+)?([A-Za-z0-9_]{0,48}(?:SECRET|TOKEN|PASSW(?:OR)?D|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]{0,48})[ \t]*=[ \t]*([^\s"'`#]{16,512})[ \t]*$/gim

/** SEC-3: names that look like credentials assigned a literal of at least 16 characters with entropy ≥ 3.5 bits, other than CSS assigned to a token name (cssLiteral). */
function findCredentialAssignments(text,options={}) {
 const found=[],types=options.code===false?[]:typeDeclarations(text)
 const consider=(name,value,index)=>{
  // Theme and design tokens are named token; CSS is never a secret's, password's or key's value.
  if(types.some(({start,end})=>index>=start&&index<end)||shannonEntropy(value)<3.5||!/secret|passw|key/i.test(name)&&cssLiteral(value))return
  if(/^(process\.env|import\.meta\.env|env\.|c\.env)/.test(value))return
  found.push({name,value,index,placeholder:isPlaceholder(value)})
 }
 for(const match of text.matchAll(assignment))if(!parameterType(text,match))consider(match[1],match[3],match.index +match[0].lastIndexOf(match[3]))
 for(const pattern of [numberAssignment,...(options.code===false?[envAssignment]:[])])for(const match of text.matchAll(pattern))if(!parameterType(text,match))consider(match[1],match[2],match.index +match[0].lastIndexOf(match[2]))
 return found
}

// A URL or module/route path is a reference, not the credential value itself.
// Known credential formats are still scanned throughout those literals.
function referenceLiteral(value){
 if(/^(?:\.{1,2}\/|\/)[A-Za-z0-9_./{}:-]+$/.test(value))return true
 // Contained bare module paths have the same reference meaning as ./module paths.
 if(/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json)$/.test(value))return true
 try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}
}

// In call('/route?token='+encodeURIComponent(value)), the quote closes the URL.
// The assignment heuristic otherwise consumes the following JS expression as a quoted value.
function queryConcatenation(text,match){
 return match.value.startsWith('+')&&/[?&][A-Za-z0-9_.-]+=["'`]$/.test(text.slice(Math.max(0,match.index-128),match.index))
}


/** The hosted rule scans every file; its extension determines identifier/type syntax only. */
export function sourceCredentialFindings(text, path) {
 return findCredentialAssignments(text, {code: codeSource(path)})
  .filter(match => !match.placeholder && !queryConcatenation(text, match) &&
   (carriesCredential(match.value) || !/^synthetic[-_]/i.test(match.value) && !referenceLiteral(match.value)))
  .map(match => ({index: match.index, rule: 'SEC-3 credential assignment'}))
  .sort((a, b) => a.index - b.index);
}

// A single worker serves the Python scanner's files without a process per blob.
// The protocol returns locations only, including on malformed input.
if (process.argv[1] === import.meta.filename) {
 const {createInterface} = await import('node:readline');
 for await (const input of createInterface({input: process.stdin, crlfDelay: Infinity})) {
  try {
   const {text, path} = JSON.parse(input);
   const findings = sourceCredentialFindings(text, path).map(({index}) => ({line: text.slice(0, index).split('\n').length}));
   process.stdout.write(JSON.stringify(findings) + '\n');
  } catch { process.stdout.write('null\n'); }
 }
}
