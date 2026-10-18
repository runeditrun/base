// Resolve the seed's actual painted palette, including CSS aliases and dark
// media rules, before Turnstile renders. A light-only seed stays light even
// when the visitor prefers dark. Marks follow the same media changes.
export const THEME_SCRIPT = `(()=>{
  const root=document.documentElement,card=document.querySelector('.card');
  const widget=document.querySelector('.cf-turnstile'),mark=document.querySelector('.brand img'),name=document.querySelector('.brand span');
  let widgetId,pixel;
  const luminance=colour=>{
    if(!pixel){const canvas=document.createElement('canvas');canvas.width=canvas.height=1;pixel=canvas.getContext('2d',{willReadFrequently:true})}
    pixel.fillStyle=colour;pixel.fillRect(0,0,1,1);
    const [r,g,b]=[...pixel.getImageData(0,0,1,1).data].slice(0,3).map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});
    return .2126*r+.7152*g+.0722*b;
  };
  window.rerDemoRender=()=>{update();if(widget)widgetId=turnstile.render(widget,{theme:widget.dataset.theme})};
  const update=()=>{
    const style=getComputedStyle(card),scheme=luminance(style.backgroundColor)<luminance(style.color)?'dark':'light';
    root.dataset.demoScheme=scheme;
    if(widget&&widget.dataset.theme!==scheme){
      widget.dataset.theme=scheme;
      if(widgetId!==undefined){window.rerDemoExpired();turnstile.remove(widgetId);window.rerDemoRender()}
    }
    const token=getComputedStyle(root).getPropertyValue('--rer-logo');
    const match=/url\\(\\s*(['"]?)([^'"\\)]+)\\1\\s*\\)/.exec(token);
    mark.hidden=true;name.removeAttribute('aria-hidden');
    if(!match)return;
    const url=new URL(match[2].trim(),location.href);
    if(url.origin!==location.origin)return;
    mark.onload=()=>{mark.hidden=false;name.setAttribute('aria-hidden','true')};
    mark.onerror=()=>{mark.hidden=true;name.removeAttribute('aria-hidden')};
    mark.src=url.href;
  };
  // The inline CSS paints the card immediately; mark/scheme work follows that
  // first frame. If Turnstile arrives sooner, its callback updates before render.
  requestAnimationFrame(()=>setTimeout(update,0));matchMedia('(prefers-color-scheme: dark)').addEventListener('change',update);
})()`;
