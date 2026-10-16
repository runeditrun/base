import { demoPlan } from '../plan.mjs';
export function nativeDemoPlan(options) {
 const {mode,...declaration}=options.declaration;
 if (mode!=='native') throw new Error('invalid-native-demo-mode');
 const plan=demoPlan({...options,declaration});
 delete plan.wrangler.containers;
 plan.wrangler.main=new URL('./worker.mjs',import.meta.url).pathname;
 plan.wrangler.compatibility_flags=['nodejs_compat','global_fetch_strictly_public'];
 plan.wrangler.assets={directory:'./assets',binding:'ASSETS',run_worker_first:true};
 plan.wrangler.durable_objects={bindings:[{name:'DEMO',class_name:'NativeVisitor'},{name:'CAPACITY',class_name:'DemoCapacity'},{name:'REGISTRY',class_name:'NativeRegistry'}]};
 plan.wrangler.migrations=[{tag:'native-v1',new_sqlite_classes:['NativeVisitor','DemoCapacity','NativeRegistry']}];
 plan.wrangler.triggers={crons:['* * * * *']};
 plan.wrangler.vars={...plan.wrangler.vars,DEMO_MODE:'native',DEMO_WORKER:plan.worker};
 return plan;
}
