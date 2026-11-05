import { materialize, ordered } from './zendesk-store.mjs';
import { fetchPage } from './zendesk-pages.mjs';

export async function guide(ctx) {
 const state = ctx.store.state;
 const resources = ['user_segments', 'categories', 'sections', 'articles', 'translations', 'article_attachments'];
 const kind = resources[state.stage];
 if (!kind) { await ctx.store.commit({ ...state, phase: 'guide_attachments', attachmentIndex: 0 }); return; }
 let article, path;
 if (state.stage < 4) path = `/api/v2/help_center/${kind}?per_page=100`;
 else {
  const data = await materialize(ctx.store);
  article = ordered(data.articles.keys())[state.index];
  if (article === undefined) { await ctx.store.commit({ ...state, stage: state.stage + 1, index: 0, path: null }); return; }
  path = `/api/v2/help_center/articles/${article}/${kind === 'article_attachments' ? 'attachments' : kind}?per_page=100`;
 }
 await fetchPage({ ...ctx, state, kind, path: state.path ?? path, allow404: true, extra: article ? { article } : {},
  onDone: state => ({ ...state, stage: state.stage + (article ? 0 : 1), index: article ? state.index + 1 : 0 }) });
}
