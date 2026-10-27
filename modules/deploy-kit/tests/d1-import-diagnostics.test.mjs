import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cloudflare } from '../index.mjs';
import { deployDiagnostic, providerFailure } from '../diagnostics.mjs';
import { ownerProvider } from './owner-provider.mjs';
import { checkout, store } from '../../../cli/fixtures/owner-deploy.mjs';
import { ownerDeploy } from '../../../cli/deploy.mjs';
import { lifecycleError } from '../../../cli/errors.mjs';
import { output } from '../../../cli/output.mjs';
import { createRedaction } from '../../../onboarding/redaction.mjs';

const rows = ['init','upload','ingest','poll'].flatMap(step => [400,413,503].map(status => ({step,status})));
rows.push({step:'upload',status:null,kind:'timeout'}, {step:'upload',status:null,kind:'reset'},
  {step:'upload',status:400,kind:'xml'},
  ...['init','ingest','poll'].map(step => ({step,status:200,kind:'nested'})));

test('D1 import failures survive the public provider, deploy and JSON doors without credentials', async t => {
  const faults = [], nativeFetch = globalThis.fetch;
  for (const row of rows) {
    const provider = ownerProvider(), cleanup = [];
    const local = {after:fn => cleanup.push(fn)};
    let transport, writer, server;
    try {
      const {root} = await checkout(local, {});
      const secret = provider.token, reason = `Edge refused ${row.step}`, code = row.kind === 'xml' ? 'InvalidRequest' : 7500;
      const signed = `https://${provider.accountId}.r2.cloudflarestorage.com/private?signature=private-signed-value`;
      const message = `${reason} ${secret} ${provider.accountId} ${signed}`;
      const reply = row.kind === 'xml' ? `<Error><Code>${code}</Code><Message>${message}</Message></Error>`
        : row.status === 413 ? `${reason} ${signed} ${secret} ` + 'é'.repeat(3 * 1024 * 1024)
        : JSON.stringify({success:false,errors:[{code,message}],echo:signed,padding:'é'.repeat(3000)});
      let failures = 0;
      server = createServer(async (req,res) => {
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const bytes = Buffer.concat(chunks), url = new URL(req.url,'http://edge.test');
          const original = url.searchParams.get('destination');
          const body = bytes.length ? bytes.toString() : undefined;
          const action = new URL(original).pathname.endsWith('/import') ? JSON.parse(body).action : undefined;
          const step = new URL(original).hostname.endsWith('.r2.cloudflarestorage.com') ? 'upload' : action;
          if (step === row.step) {
            failures++;
            if (row.kind === 'timeout') return;
            if (row.kind === 'reset') { req.socket.destroy(); return; }
            if (row.kind === 'nested') {
              res.writeHead(200,{'content-type':'application/json'});
              res.end(JSON.stringify({success:true,result:{success:true,type:'import',status:'error',errors:[{code,message}]}})); return;
            }
            res.writeHead(row.status,{'content-type':row.status === 413 ? 'text/plain' : 'application/json'}); res.end(reply); return;
          }
          if (action === 'poll') throw Error('unexpected successful poll');
          const response = await provider.fetch(original,{method:req.method,redirect:'error',body,
            headers:{Authorization:req.headers.authorization,'Content-Length':req.headers['content-length']}});
          let data = Buffer.from(await response.arrayBuffer());
          if (action === 'init' && row.step === 'upload') data = Buffer.from(JSON.stringify({...JSON.parse(data),padding:'x'.repeat(100000)}));
          if (action === 'ingest' && row.step === 'poll') data = Buffer.from(JSON.stringify({success:true,result:{success:true,type:'import',status:'active',at_bookmark:'edge-bookmark'}}));
          res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(data);
        } catch (error) { res.writeHead(500); res.end(String(error)); }
      });
      server.listen(0,'127.0.0.1'); await once(server,'listening');
      const fetch = (destination, init) => nativeFetch(`http://127.0.0.1:${server.address().port}/?destination=${encodeURIComponent(destination)}`,init);
      const api = cloudflare({...provider,fetch,timeoutMs:100});
      const db = await api.request('/d1/database',{method:'POST',body:{name:'module-probe'}});
      let raw;
      await assert.rejects(api.importSql(db.uuid,'CREATE TABLE probe(id TEXT);'),error => {raw = error; return true;});
      assert.equal(raw.d1Import.step,row.step); assert.equal(raw.status,row.status);
      if (row.step === 'upload' && row.status !== null) assert.equal(raw.message,'d1-import-upload-failed');
      const redaction = createRedaction(); redaction.addSecrets([secret,provider.accountId]);
      const diagnostic = deployDiagnostic(raw,redaction.redact);
      assert.ok(diagnostic); assert.ok(Buffer.byteLength(diagnostic.d1Import.body) <= 2048);
      if (row.status !== null) {
        assert.ok(providerFailure(raw).includes(String(row.status)));
        assert.ok(JSON.stringify(diagnostic).includes(reason));
        if (row.status !== 413) assert.equal(raw.d1Import.errors[0].code,code);
      } else assert.ok(raw.d1Import.causeCode);
      const before = failures;
      const envNames = ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN'], saved = envNames.map(name => process.env[name]);
      cleanup.push(() => envNames.forEach((name,i) => {if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];}));
      Object.assign(process.env,{CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:secret});
      transport = t.mock.method(globalThis,'fetch',fetch);
      const commandStore = store(); let failure;
      await assert.rejects(ownerDeploy('deploy.json',{run:async () => {}})({root,options:{nonInteractive:true,json:true},store:commandStore}),error => {failure = error; return true;});
      failure = await lifecycleError(failure,commandStore);
      assert.equal(failure.d1Import?.step,row.step,failure.message);
      assert.equal(failure.d1Import.status,row.status);
      assert.equal(failures-before,1,'a refused upload/import is not replayed');
      const lines = [];
      writer = t.mock.method(process.stdout,'write',text => {lines.push(String(text)); return true;});
      const out = output({verb:'deploy',json:true}); out.error(failure); out.result(false,1,{d1Import:failure.d1Import});
      writer.mock.restore(); writer = undefined;
      const events = lines.join('').trim().split('\n').map(line => JSON.parse(line));
      for (const event of events) {
        assert.equal(event.d1Import.status,row.status); assert.equal(event.d1Import.step,row.step);
        assert.ok(Buffer.byteLength(event.d1Import.body) <= 2048);
        if (row.status !== null) assert.ok(JSON.stringify(event).includes(reason));
        else assert.ok(event.d1Import.causeCode);
      }
      const exposed = JSON.stringify([raw,diagnostic,events]);
      for (const value of [secret,provider.accountId,signed,'private-signed-value']) assert.ok(!exposed.includes(value));
    } catch (error) { faults.push(new Error(`${row.step}/${row.status}/${row.kind ?? 'http'}: ${error.stack}`,{cause:error})); }
    finally {
      writer?.mock.restore(); transport?.mock.restore();
      if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
      provider.close(); for (const close of cleanup.reverse()) await close();
    }
  }
  if (faults.length) throw new AggregateError(faults,faults.map(error => error.message).join('\n'));
});
