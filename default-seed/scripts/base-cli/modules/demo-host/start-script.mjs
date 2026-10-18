// The start page's script. Once Turnstile passes it starts the demo with fetch
// (Accept: application/json), so the visitor sees each step: the check, their
// private copy starting, and the sign-in. A refusal, a network failure or a start
// past 25 seconds is said plainly with a Try again that runs a new check. On a
// refusal page the server rendered (data-auto="0") the visitor presses Start
// instead. Turnstile renewing its token later never starts a demo by itself.
// Without JavaScript the form posts as a plain form.
export const START_SCRIPT = `(()=>{
const SLOW=25000,LONG=12000;
let page,attempt,timers=[];
const el=()=>page??=(form=>({form,button:form.querySelector('.button'),label:form.querySelector('.label'),steps:[...form.querySelectorAll('.steps li')],note:document.getElementById('note'),live:document.getElementById('status'),notice:document.getElementById('notice'),auto:form.dataset.auto==='1'}))(document.getElementById('start'));
function show(state,{label,note,live,step,notice}){
  const p=el();
  p.form.dataset.state=state;
  p.button.disabled=!['ready','slow','failed'].includes(state);
  p.label.textContent=label;
  if(note!==undefined)p.note.textContent=note;
  if(live!==undefined)p.live.textContent=live;
  if(step!==undefined)p.steps.forEach((item,index)=>item.dataset.at=index<step?'done':index===step?'now':'next');
  if(notice!==undefined){p.notice.textContent=notice;p.notice.hidden=!notice}
}
function waiting(){
  const auto=el().auto;
  show('waiting',{label:'Waiting for the human check…',note:auto?'Your demo will open automatically when ready.':'Once the check passes, press Start the demo.'});
}
function stop(){timers.forEach(clearTimeout);timers=[]}
async function go(resume=false){
  const p=el(),controller=attempt=new AbortController();
  show('working',{label:'Starting your demo…',note:'Your demo will open automatically when ready.',live:'Check passed. Starting a private copy.',step:1,notice:''});
  timers.push(setTimeout(()=>p.note.textContent='Taking a little longer than usual. Still starting…',LONG));
  timers.push(setTimeout(()=>show('slow',{label:'Try again',note:'Still starting. It will open by itself if it finishes.',notice:'This is taking longer than it should. Keep waiting, or try again.'}),SLOW));
  try{
    let response=await fetch(resume?'/__demo/status':p.form.action,{...(resume?{}:{method:'POST',body:new URLSearchParams(new FormData(p.form))}),headers:{accept:'application/json'},signal:controller.signal});
    let result=await response.json().catch(()=>({}));
    while(response.status===202&&result.pending===true){
      // The server holds each pending answer until the start changes.
      await new Promise(resolve=>setTimeout(resolve,100));
      if(attempt!==controller)return;
      response=await fetch('/__demo/status',{headers:{accept:'application/json'},signal:controller.signal});
      result=await response.json().catch(()=>({}));
    }
    if(attempt!==controller)return;
    stop();
    if(response.ok&&typeof result.location==='string'){
      show('signing',{label:'Starting your demo…',note:'Opening your demo…',live:'Your copy is running. Signing you in…',step:2,notice:''});
      location.assign(result.location);
      return;
    }
    show('failed',{label:'Try again',note:'',live:'',notice:result.notice||'The demo did not start. Try again.'});
  }catch{
    if(attempt!==controller)return;
    stop();
    show('failed',{label:'Try again',note:'',live:'',notice:'The demo could not be reached. Check your connection, then try again.'});
  }
}
async function again(){
  attempt?.abort();attempt=null;stop();
  el().auto=false;
  show('working',{label:'Trying again…',note:'Your new demo will start after the human check.',live:'Trying again.',notice:''});
  try{
    const response=await fetch('/__demo/cancel',{method:'POST',headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('cancel-failed');
  }catch{
    show('failed',{label:'Try again',note:'',live:'',notice:'The previous demo could not be ended. Try again.'});
    return;
  }
  el().auto=true;
  show('waiting',{label:'Waiting for the human check…',note:'Running the check again. The demo starts by itself once it passes.',live:'Running the human check again.',notice:''});
  turnstile.reset(el().form.querySelector('.cf-turnstile'));
}
// Turnstile's callbacks; once a start is under way only a new check (Try again) changes the page.
const checking=()=>['waiting','ready'].includes(el().form.dataset.state);
window.rerDemoVerified=()=>checking()&&(el().auto?go():show('ready',{label:'Start the demo',note:'Check passed. Press Start the demo.',live:'Check passed. Press Start the demo.'}));
window.rerDemoInteractive=()=>checking()&&show('waiting',{label:'Waiting for the human check…',note:'Tick the box above to show you are human.',live:'Tick the box above to show you are human.'});
window.rerDemoChecking=()=>checking()&&waiting();
window.rerDemoExpired=()=>checking()&&waiting();
window.rerDemoCheckFailed=()=>checking()&&show('failed',{label:'Try again',note:'',live:'',notice:'The human check did not load. Try again.'});
addEventListener('DOMContentLoaded',()=>{
  if(el().form.dataset.resume==='1')go(true);
  else if(el().form.dataset.state==='waiting')waiting();
  el().form.addEventListener('submit',event=>{
    event.preventDefault();
    const state=el().form.dataset.state;
    if(state==='ready')go();
    else if(state==='slow'||state==='failed')again();
  });
});
})()`;
