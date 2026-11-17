import { register } from 'node:module';

let active=false;
export function activatePortabilityRuntime() {
 if(active)return;
 // The selected dispatcher owns installation archives. A seed supplies the
 // bindings and policy, even when its node_modules holds another rer version.
 register(import.meta.url,import.meta.url);
 active=true;
}

export function resolve(specifier,context,nextResolve) {
 if(specifier==='@runeditrun/rer/portability')
  return {url:new URL('./portability.mjs',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
