import {checkCases} from './test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as setup from './setup-validation.mjs';
const manifestCases = [];
const manifestCase = (name, check) => manifestCases.push([name, check]);
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const schema = read('SETUP.schema.json');
const example = read('SETUP.example.json');
// Independent small manifest keeps regressions isolated from example migration.
const base = () => ({schema:1,title:'Setup',groups:[],fields:[
  {name:'PROVIDER_URL',label:'Provider URL',kind:'url'},
  {name:'OWNER_EMAIL',label:'Owner',kind:'email',prefill:'account-email',required:true},
  {name:'API_KEY',label:'API key',kind:'secret',required:false,ownerVisible:false}
],steps:[{type:'owner-claim',mode:'setup-token',emailField:'OWNER_EMAIL'}]});
const valid = data => assert.deepEqual(setup.validateSetupManifest(schema,data), []);
const invalid = data => assert(setup.validateSetupManifest(schema,data).length > 0);

manifestCase('explicit entered secrets allow owner input without a generator',()=>{
 const data=base();Object.assign(data.fields[2],{input:'entered',ownerVisible:true});valid(data);
});
manifestCase('explicit managed secrets are hidden with or without generation',()=>{
 for(const generate of [undefined,'hex','base64']){const data=base();Object.assign(data.fields[2],{input:'managed',...(generate?{generate}:{})});valid(data)}
});
for(const [name,patch] of [
 ['entered hidden',{input:'entered'}],['entered generated',{input:'entered',ownerVisible:true,generate:'hex'}],
 ['managed visible',{input:'managed',ownerVisible:true}],['unmarked visible',{ownerVisible:true}],['unknown input',{input:'other'}]
])manifestCase(`rejects ${name} secret`,()=>{const data=base();Object.assign(data.fields[2],patch);invalid(data)});
manifestCase('public fields cannot declare secret input mode',()=>{const data=base();data.fields[0].input='entered';invalid(data)});
for(const runtimeEditable of [true,false])manifestCase(`rejects secret runtimeEditable ${runtimeEditable}`,()=>{const data=base();data.fields[2].runtimeEditable=runtimeEditable;invalid(data)});
manifestCase('rejects unknown runtime exclusion',()=>{const data=base();data.runtime={additionalFields:true,exclude:['UNKNOWN']};invalid(data)});
manifestCase('declared runtime exclusions are valid',()=>{const data=base();data.runtime={additionalFields:true,exclude:['PROVIDER_URL']};valid(data)});
for(const [kind,value] of [['colour','red'],['timezone','Nowhere/Bad'],['url','notaurl'],['url','ftp://example.org'],['url','https://user:password@example.org'],['email','nope'],['email',`${'x'.repeat(247)}@ex.test`],['text','x'.repeat(16385)],['select','missing']])manifestCase(`rejects invalid ${kind} default ${value.slice(0,25)}`,()=>{
 const data=base();data.fields.push({name:'DEFAULT_VALUE',label:'Value',kind,default:value,...(kind==='select'?{options:[{value:'ok',label:'OK'}]}:{})});invalid(data);
});
manifestCase('rejects empty select default without a declared empty option',()=>{
 const data=base();data.fields.push({name:'SELECT_VALUE',label:'Selection',kind:'select',default:'',options:[{value:'ok',label:'OK'}]});invalid(data);
});
manifestCase('valid defaults follow install value rules including empty values and caps',()=>{
 for(const [kind,value] of [['colour','#abcdef'],['timezone','Australia/Brisbane'],['url','https://example.org'],['email',' OWNER@example.org '],['text','x'.repeat(16384)],['select','ok'],...['colour','timezone','url','email','select'].map(kind=>[kind,''])]){
 const data=base();data.fields.push({name:'DEFAULT_VALUE',label:'Value',kind,default:value,...(kind==='select'?{options:[{value:'ok',label:'OK'},{value:'',label:'None'}]}:{})});valid(data);
 }
});
manifestCase('edition-owned neutral extension identifiers are accepted',()=>{const data=base();data.steps.push({type:'extension',id:'calendar-sync-2'});valid(data)});
for(const id of ['','Uppercase','bad_id','x'.repeat(65)])manifestCase(`rejects invalid extension ID ${id}`,()=>{const data=base();data.steps.push({type:'extension',id});invalid(data)});
manifestCase('nonempty conditions accept earlier public kinds',()=>{
 for(const kind of ['text','email','url','colour','timezone','select']){const data=base();data.fields[0].kind=kind;if(kind==='select')data.fields[0].options=[{value:'',label:'None'},{value:'ok',label:'OK'}];data.fields[2].when={field:'PROVIDER_URL',nonEmpty:true};valid(data)}
});
for(const [name,when] of [['both operators',{field:'PROVIDER_URL',equals:'x',nonEmpty:true}],['neither operator',{field:'PROVIDER_URL'}],['false nonempty',{field:'PROVIDER_URL',nonEmpty:false}],['undeclared',{field:'MISSING',nonEmpty:true}],['secret dependency',{field:'API_KEY',nonEmpty:true}]])manifestCase(`rejects condition ${name}`,()=>{const data=base();data.fields[2].when=when;invalid(data)});
manifestCase('rejects later nonempty dependency',()=>{const data=base();data.fields[0].when={field:'OWNER_EMAIL',nonEmpty:true};invalid(data)});
manifestCase('empty equality and nonempty presentations partition a public text value',()=>{
 const data=base();data.fields[0].kind='text';data.fields[2].presentations=[{when:{field:'PROVIDER_URL',equals:''},required:false},{when:{field:'PROVIDER_URL',nonEmpty:true},required:true}];valid(data);
});
for(const [name,conditions] of [['overlap',[{nonEmpty:true},{equals:'yes'}]],['duplicate nonempty',[{nonEmpty:true},{nonEmpty:true}]]])manifestCase(`rejects presentation ${name}`,()=>{const data=base();data.fields[0].kind='text';data.fields[2].presentations=conditions.map(condition=>({when:{field:'PROVIDER_URL',...condition}}));invalid(data)});
manifestCase('duplicate equality presentations retain the established diagnostic',()=>{
 const data=base();data.fields[0].kind='text';
 data.fields[2].presentations=[{when:{field:'PROVIDER_URL',equals:'same'}},{when:{field:'PROVIDER_URL',equals:'same'}}];
 assert(setup.validateSetupManifest(schema,data).some(error=>/presentation condition values must be unique/.test(error)));
});
manifestCase('group nonempty presentations reference declared public values',()=>{const data=base();data.groups=[{id:'provider',label:'Provider',presentations:[{when:{field:'PROVIDER_URL',nonEmpty:true},help:'Configured'}]}];valid(data)});
test('shared condition evaluator uses string nonemptiness without coercion or trimming',()=>{
 assert.equal(typeof setup.setupConditionMatches,'function');
 for(const value of [undefined,null,false,0,{},''])assert.equal(setup.setupConditionMatches({field:'A',nonEmpty:true},{A:value}),false);
 for(const value of [' ','0','https://example.org'])assert.equal(setup.setupConditionMatches({field:'A',nonEmpty:true},{A:value}),true);
 assert.equal(setup.setupConditionMatches({field:'A',equals:''},{A:''}),true);
 assert.equal(setup.setupConditionMatches({field:'A',equals:''},{}),false);
});
test('shared setup value validator enforces install rules',()=>{
 assert.equal(typeof setup.validateSetupValue,'function');
 assert.throws(()=>setup.validateSetupValue({name:'URL',kind:'url'},'invalid'),/Invalid URL/);
 assert.doesNotThrow(()=>setup.validateSetupValue({name:'SELECT',kind:'select',options:[{value:'ok'}]},''));
});

test('portable negative corpus rejects malformed manifests and parser inputs',()=>{
 const corpus=read('setup-negative-corpus.json');
 for(const entry of corpus.cases){
  if(entry.text||entry.hex){assert.throws(()=>setup.parseSetupManifestBytes(entry.hex?Buffer.from(entry.hex,'hex'):Buffer.from(entry.text)));continue}
  const data=entry.file?read(entry.file):structuredClone(example);
  for(const operation of entry.operations??[]){let target=data;for(const key of operation.path.slice(0,-1))target=target[key];const key=operation.path.at(-1);if(operation.op==='delete')delete target[key];else target[key]=structuredClone(operation.value)}
  assert(setup.validateSetupManifest(schema,data).length>0,entry.name);
 }
});

test('setup manifest input policies accept supported forms and reject unsafe forms', () => checkCases(manifestCases));
