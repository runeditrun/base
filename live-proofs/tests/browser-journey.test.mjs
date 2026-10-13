import test from 'node:test';
import assert from 'node:assert/strict';
import { browserJourney } from '../../scripts/qualification/browser.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';

// Browser protocol fixture only: uploads deliberately do not resolve until the
// widget Send action. No application routes or mock browser exist in production.
test('browser journey clicks Send before awaiting upload and requires operator/socket/reload readback',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async()=>new Response('real-script-fixture');
 const origin='https://throwaway.example', events=[], pending=new Map();
 let pages=0, frame, requestContent, replyContent, mediaBytes, closed=false, widgetReloaded=false;
 const response=(status,json)=>({status:()=>status,json:async()=>json});
 const identity={conversationId:'conversation-id',contactId:'visitor-id',projectId:'project-id'};
 const publish=()=>frame({payload:JSON.stringify({eventId:2,message:{id:'operator-message',content:replyContent}})});
 function page(role) {
  const locator=selector=>({
   getByText(){return locator(selector);},
   async fill(value){if(selector==='textarea[name=content]')requestContent=value;if(selector==='Type your reply…')replyContent=value;},
   async waitFor(){events.push(role+':visible:'+selector);},
   async setInputFiles(file){mediaBytes=file.buffer;events.push('file-selected');},
   async boundingBox(){return {width:390};},
   async click(){
    events.push(role+':click:'+selector);
    if(role==='widget'){
     assert.equal(selector,'button[name=submit]');
     assert(mediaBytes && requestContent);
     pending.get('media')(response(201,{id:'media-id'}));
     pending.get('visitor')(response(200,{accepted:true,message:{id:'visitor-message'}}));
    } else if(selector==='Send'){
     assert(replyContent);publish();
     pending.get('operator')(response(200,{accepted:true,message:{id:'operator-message',actor_role:'owner'}}));
    }
   },
  });
  return {
   on(name,handler){if(name==='websocket')handler({url:()=>origin+'/api/conversations/conversation-id/socket',on(event,callback){assert.equal(event,'framereceived');frame=callback;}});},
   async goto(url){events.push(role+':goto:'+url);},
   async waitForURL(url){assert.equal(url,'**/conversations');},
   getByLabel:locator,getByRole(kind,{name}){assert.equal(kind,'button');return locator(name);},
   getByPlaceholder:locator,locator,getByText:locator,
   waitForResponse(predicate){
    const kind=role==='operator'?'operator':predicate({url:()=>origin+'/api/conversations/conversation-id/media',request:()=>({method:()=> 'POST'})})?'media':'visitor';
    return new Promise(resolve=>pending.set(kind,resolve));
   },
   async evaluate(fn,key){assert.equal(key,'rer-widget:'+origin+':widget-key');return identity;},
   async reload(){events.push(role+':reload');if(role==='widget'){widgetReloaded=true;publish();}},
   async setViewportSize(size){assert.deepEqual(size,{width:390,height:844});},
  };
 }
 const chromium={launch:async()=>({newPage:async()=>page(pages++?'widget':'operator'),close:async()=>{closed=true;}})};
 const result=await browserJourney({origin,owner:{projectId:'project-id'},email:'test@example.test',password:'generated-test-password',widgetKey:'widget-key'},chromium);
 assert(closed && widgetReloaded);
 assert(events.includes('operator:goto:'+origin+'/projects/project-id/conversations/conversation-id'));
 assert(events.indexOf('file-selected')<events.indexOf('widget:click:button[name=submit]'));
 assert(events.indexOf('widget:click:button[name=submit]')<events.indexOf('operator:click:Send'));
 assert.equal(result.reply.requestSha256,digest(requestContent));assert.equal(result.reply.replySha256,digest(replyContent));
 assert.equal(result.media.sha256,digest(mediaBytes));
 assert(result.reply.replayVerified && result.reply.reloadVerified);
});
