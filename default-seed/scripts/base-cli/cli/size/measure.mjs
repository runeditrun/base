import { signPersonasIn } from './personas.mjs';
import { runFlows } from './flows.mjs';

/** What runs on a built install, while it is still open: the declared personas sign in, then every flow runs through
 * the meter in declared order. The result is `buildInstall`'s `measured`: the runFlows results of this size. */
export const measureInstall = run => async ({ hosted, owner, meter, timed }) => {
 const personas = await timed('personas', undefined, () => signPersonasIn(hosted, run.declaration.personas, { ownerCookie: owner?.cookie }));
 return runFlows(run.declaration.flows, { hosted, personas, meter, now: run.now }, (flow, work) => timed('flows', flow.name, work));
};
