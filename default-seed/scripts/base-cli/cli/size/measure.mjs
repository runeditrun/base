import { RerError } from '../errors.mjs';
import { signPersonasIn } from './personas.mjs';
import { runFlows } from './flows.mjs';

/** What runs on a built install, while it is still open: the declared personas sign in, then every flow runs through
 * the meter in declared order. The result is `buildInstall`'s `measured`: the runFlows results of this size. */
export const measureInstall = run => async ({ hosted, owner, meter, results, timed }) => {
 const personas = await timed('personas', undefined, async () => {
  const signed = await signPersonasIn(hosted, run.declaration.personas, { ownerCookie: owner?.cookie });
  // Bootstrap/persona waitUntil work belongs to setup, never the first declared flow.
  const window = meter.open();
  if ((await window.close()).unsettled) throw new RerError('size_setup_incomplete', 'Owner or persona work did not settle; no flows were measured.', 1);
  return signed;
 });
 return runFlows(run.declaration.flows, { hosted, personas, meter, results, now: run.now }, (flow, work) => timed('flows', flow.name, work));
};
