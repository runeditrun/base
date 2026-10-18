// Like the Lobby, load the seed's served theme and show its mark beside the
// product name. Resolve the CSS token in the browser so dark-mode marks work
// too. A missing or broken image leaves the product's text visible.
export const LOGO_SCRIPT = `(()=>{
  const mark=document.querySelector('.brand img'),name=document.querySelector('.brand span');
  const update=()=>{
    const token=getComputedStyle(document.documentElement).getPropertyValue('--rer-logo');
    const match=/url\\(\\s*(['"]?)([^'"\\)]+)\\1\\s*\\)/.exec(token);
    mark.hidden=true;name.removeAttribute('aria-hidden');
    if(!match)return;
    const url=new URL(match[2].trim(),location.href);
    if(url.origin!==location.origin)return;
    mark.onload=()=>{mark.hidden=false;name.setAttribute('aria-hidden','true')};
    mark.onerror=()=>{mark.hidden=true;name.removeAttribute('aria-hidden')};
    mark.src=url.href;
  };
  update();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',update);
})()`;
