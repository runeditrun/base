import type { CatalogueOrdering, Options } from './types.ts';
import { publicCall, allowed } from './store.ts';
import { grant, project, resolve, validateOffer } from './selection.ts';
import { save, review } from './drafts.ts';
import { freeze } from './commit.ts';
import { read, exportRecords } from './artifacts.ts';
import { integer, LIMITS, object, refuse, text } from './validation.ts';
export type * from './types.ts';
export * from './decimal.ts';
export * from './arithmetic.ts';
export { LIMITS } from './validation.ts';
export { verifyExportArtifact, restoreHistory } from './artifacts.ts';

export function createCatalogueOrdering(options: Options): CatalogueOrdering {
  return {
    listOffers:(ctx,input)=>publicCall(ctx,async()=>{
      object(input,['subject','cursor','limit']);integer(input.limit,1,LIMITS.page);if(input.cursor!==null)text(input.cursor);
      const access=await grant(options,ctx,'offers',input.subject);
      let page;try{page=await options.offers.list(ctx,input.subject,input);}catch{refuse('source_unavailable');}
      if(page.offers.length>input.limit)refuse('capacity');
      page.offers.forEach(offer=>validateOffer(offer,input.subject));
      if(page.next!==null)text(page.next);
      await allowed(options.db,page.guard,'stale_review');await allowed(options.db,access.guard,'authority_refused');
      return {offers:page.offers,next:page.next};
    }),
    resolveSelection:(ctx,input)=>publicCall(ctx,async()=>{object(input,['subject','lines']);const access=await grant(options,ctx,'selection',input.subject);const value=await resolve(options,ctx,input);await allowed(options.db,access.guard,'authority_refused');return project(value.commercial,access.fields);}),
    saveDraft:(ctx,input)=>publicCall(ctx,()=>save(options,ctx,input)),
    reviewSelection:(ctx,input)=>publicCall(ctx,()=>review(options,ctx,input)),
    freezeSelection:(ctx,input)=>publicCall(ctx,()=>freeze(options,ctx,input)),
    readSnapshot:(ctx,input)=>publicCall(ctx,()=>read(options,ctx,input)),
    exportRecords:(ctx,input)=>publicCall(ctx,()=>exportRecords(options,ctx,input))
  };
}
