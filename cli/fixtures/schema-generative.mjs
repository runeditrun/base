import assert from 'node:assert/strict';
import { readArchive } from '../../modules/portability/index.mjs';
import { schemaIdentityOf } from '../../modules/portability/schema-identity.mjs';
import { sqliteTokens, significantBoundary } from '../../modules/portability/sqlite-tokens.mjs';
import { schemaCorpus } from './schema-corpus.mjs';

// Exercise the public archive reader's authenticated schema door. An unchanged
// identity must open; a changed definition must refuse before a row is read.
async function opens(manifest) {
 const reader = readArchive(new Response(JSON.stringify(manifest)+'\n').body);
 try { await reader.next(); return true; }
 catch (error) {
  assert.ok(['schema_checksum','schema_mismatch:unsupported_sql'].includes(error.code),error.message);
  return false;
 } finally { await reader.return(); }
}
const replace = (sql, start, end, value) => sql.slice(0,start)+value+sql.slice(end);
export async function schemaGenerative() {
 const corpus = await schemaCorpus(), alternatives = new Map();
 const statements = corpus.map(entry => ({...entry,tokens:sqliteTokens(entry.sql)}));
 for (const {tokens} of statements) for (const token of tokens) {
  if (!alternatives.has(token.type)) alternatives.set(token.type,new Map());
  alternatives.get(token.type).set(token.value,token.text);
 }
 const counts = {statements:corpus.length,boundaries:0,insignificant:0,significant:0,formatting:0,refusedRemovals:0,mutations:0,literals:0,unsupported:0};
 for (const {origin,sql,tokens} of statements) {
  const object = {name:'definition',type:'view',table:'definition',sql};
  const manifest = {kind:'manifest',format:'runeditrun-portability',version:2,product:'schema-generative',
   sourceIdentity:'corpus',exportedAt:'corpus',epoch:0,partCount:0,tables:[],schemaObjects:[object],
   objects:[],payloads:[],journal:[],requiredConfiguration:[],excludedColumns:{}};
  manifest.schema = await schemaIdentityOf([],manifest.schemaObjects);
  assert.equal(await opens(manifest),true,origin);
  const check = async (changed, expected, description) => {
   const candidate = {...manifest,schemaObjects:[{...object,sql:changed}]};
   assert.equal(await opens(candidate),expected,`${origin}: ${description}`);
  };
  for (let i=1;i<tokens.length;i++) {
   const left=tokens[i-1],right=tokens[i],significant=significantBoundary(left,right);
   counts.boundaries++;counts[significant?'significant':'insignificant']++;
   for (const separator of ['', ' ', '\t\n', '/**/', ' -- boundary\n']) {
    const expected = separator!=='' || !significant;
    await check(replace(sql,left.end,right.start,separator),expected,`boundary ${i} ${JSON.stringify(separator)}`);
    if(expected)counts.formatting++;else counts.refusedRemovals++;
   }
  }
  for (const token of tokens) {
   const replacement = [...alternatives.get(token.type)].find(([value]) => value!==token.value)?.[1];
   if (replacement===undefined) continue;
   await check(replace(sql,token.start,token.end,replacement),false,`same-class mutation at ${token.start}`);
   counts.mutations++;
   if (['string','blob','integer','float','hex'].includes(token.type)) counts.literals++;
  }
  // Unsupported syntax must refuse even if the old checksum could erase it.
  for (const suffix of ['\0','\v','\ufeff'," 'unterminated",' /* unfinished'," x'0'",' 1__0',' :',' !']) {
   await check(sql+'\n'+suffix,false,'unsupported syntax'); counts.unsupported++;
  }
 }
 console.log('schema generative sweep:',JSON.stringify(counts));
}
