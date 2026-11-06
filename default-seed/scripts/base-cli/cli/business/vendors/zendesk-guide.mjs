import { fail, object } from './common.mjs';
import { materialize, ordered } from './zendesk-store.mjs';
import { fetchPage } from './zendesk-pages.mjs';

const stages = [
 ['user_segments'], ['categories'], ['sections'], ['articles'],
 ['source_articles'], ['translations', 'categories'], ['translations', 'sections'], ['translations', 'articles'], ['article_attachments', 'articles'],
];
export async function guide(ctx) {
 const state = ctx.store.state, stage = stages[state.stage];
 if (!stage) { await ctx.store.commit({ ...state, phase: 'guide_attachments', attachmentIndex: 0 }); return; }
 const [kind, resource] = stage;
 let article, path;
 if (state.stage < 4) path = `/api/v2/help_center/${kind}?per_page=100`;
 else {
  const data = await materialize(ctx.store), records = data[resource ?? 'articles'];
  article = ordered(records.keys())[state.index];
  if (article === undefined) { await ctx.store.commit({ ...state, stage: state.stage + 1, index: 0, path: null }); return; }
  if (kind === 'source_articles') {
   const row = records.get(article).row;
   if (typeof row.source_locale !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(row.source_locale)) fail('INVALID_RESPONSE');
   if (row.locale !== row.source_locale) {
    const response = await ctx.request(`/api/v2/help_center/${row.source_locale}/articles/${article}`);
    const source = object(response.body.article);
    if (String(source.id) !== article || source.locale !== row.source_locale) fail('INVALID_RESPONSE');
    await ctx.store.page('articles', response, { ...state, index: state.index + 1 }, { single: 'article' });
   } else await ctx.store.commit({ ...state, index: state.index + 1 });
   return;
  }
  path = `/api/v2/help_center/${resource}/${article}/${kind === 'article_attachments' ? 'attachments' : kind}?per_page=100`;
 }
 await fetchPage({ ...ctx, state, kind, path: state.path ?? path, allow404: true, extra: article ? { article, resource } : {},
  onDone: state => ({ ...state, stage: state.stage + (article ? 0 : 1), index: article ? state.index + 1 : 0 }) });
}
