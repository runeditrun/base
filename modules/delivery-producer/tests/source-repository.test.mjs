import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProjectDescriptor} from '../generators/project.mjs';

const cases=JSON.parse(readFileSync(new URL('./source-repository-cases.json',import.meta.url),'utf8').replaceAll('{github-host}', 'github.com').replaceAll('{GITHUB-HOST}', 'GITHUB.COM').replaceAll('{GitHub-Host}', 'GiThUb.CoM'));
const descriptor={schema:1,projectId:'publisher/app',name:'App',sourceRepository:'octocat/Hello-World',license:'MIT',deployment:{target:'cloudflare-workers'},operations:{build:'make build',verify:'make test',recovery:'Restore retained data'}};
for(const value of cases.acceptedBare)test(`descriptor producer canonicalizes legacy ${value}`,()=>{
 assert.equal(generateProjectDescriptor({...descriptor,sourceRepository:value}).sourceRepository,`https://github.com/${value}`);
});
for(const value of cases.unrepresentableBare)test(`descriptor producer refuses an unrepresentable bare identity ${value}`,()=>{
 assert.throws(()=>generateProjectDescriptor({...descriptor,sourceRepository:value}),/literal \.git repository name/);
});
for(const {value,identity,canonicalizable} of cases.acceptedUrls)test(`descriptor producer ${canonicalizable===false?'refuses an unrepresentable identity in':'canonicalizes'} ${JSON.stringify(value)}`,()=>{
 if(canonicalizable===false){
  assert.throws(()=>generateProjectDescriptor({...descriptor,sourceRepository:value}),/literal \.git repository name/);
  return;
 }
 const result=generateProjectDescriptor({...descriptor,sourceRepository:value});
 assert.equal(result.sourceRepository,`https://github.com/${identity}`);
 assert.deepEqual(generateProjectDescriptor(result),result);
});
for(const value of [...cases.rejectedUrls,...cases.rejectedBare])test(`descriptor producer rejects ${JSON.stringify(value)}`,()=>{
 assert.throws(()=>generateProjectDescriptor({...descriptor,sourceRepository:value}),/https:\/\/github\.com\/<owner>\/<repo>/);
});
