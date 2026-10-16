// worker-engine binds every namespace to a class in this Worker. Never silently
// reinterpret a cross-worker namespace as a local one. Check the bundler's actual
// entry exports: workerd readiness alone does not reject missing class exports.
export function localDurableObjects(config, exports) {
 const bindings=config.durable_objects?.bindings??[];
 if(!Array.isArray(bindings))throw new Error('Container Durable Object bindings must be an array');
 for(const binding of bindings) {
  if(!binding||typeof binding.name!=='string'||!binding.name||typeof binding.class_name!=='string'||!binding.class_name)throw new Error('Container Durable Object binding requires name and class_name');
  if(Object.hasOwn(binding,'script_name')||Object.hasOwn(binding,'environment'))throw new Error('Container Durable Object bindings do not support script_name or environment');
 }
 const classes=new Set(bindings.map(binding=>binding.class_name));
 if(classes.size&&!exports)throw new Error('Built container Worker entry exports are unavailable');
 for(const name of classes)if(!exports.has(name))throw new Error('Built container Worker does not export configured Durable Object class: '+name);
 return classes;
}
