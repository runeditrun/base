/** Lexical context for the SEC-3 source rule. No source values leave this module. */
/** These source languages use bare names as expressions; configuration files can have unquoted string literals. */
export const codeSource=(path)=>path===undefined||/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp|cc|c|h|swift|rb)$/i.test(path)

export const sourceTokens=/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/(?![*/])(?:\\[\s\S]?|\[(?:\\[\s\S]?|[^\]\\])*(?:\]|$)|[^/\\[\n])+(?:\/[a-z]*|$)|"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|`(?:\\[\s\S]?|[^`\\])*(?:`|$)|[A-Za-z_$][\w$]*|[^\s]/g

/** Type declarations are recognized outside comments and strings, so text cannot hide later assignments. */
export function typeDeclarations(text) {
 if(!/\b(?:interface|type)\s+[A-Za-z_$]/.test(text))return []
 const tokens=[...text.matchAll(sourceTokens)].filter(token=>!token[0].startsWith('//')&&!token[0].startsWith('/*'))
 const ranges=[]
 for(let i=0;i<tokens.length;i++){
  const start=tokens[i],kind=start[0]
  if(!['interface','type'].includes(kind)||!/^\w+$/.test(tokens[i+1]?.[0]??''))continue
  let j=i+2
  while(j<tokens.length&&!['{','=',';',':'].includes(tokens[j][0]))j++
  if(tokens[j]?.[0]!== (kind==='interface'?'{':'='))continue
  let depth=kind==='interface'?1:0,end=tokens[j].index +1
  for(j++;j<tokens.length;j++){
   const token=tokens[j],value=token[0]
   if(depth===0&&(value===';'||text.slice(end,token.index).includes('\n')&&!['|','&','{'].includes(value)))break
   if(['{','(','['].includes(value))depth++
   if(['}',')',']'].includes(value)&&--depth===0){end=token.index +1;if(kind==='interface')break;continue}
   end=token.index +value.length
  }
  ranges.push({start:start.index,end,continuation:j===tokens.length?(kind==='interface'?'interface ScanContext ':'type ScanContext = ')+ '{'.repeat(Math.max(0,depth)):''})
 }
 return ranges
}
