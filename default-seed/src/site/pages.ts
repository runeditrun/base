// The run site `rer build --site` writes: the homepage with its Run action,
// /run, the not-found page and the public files they use. It reads no
// installation data, only edition identity and Run data.
import { runPageHtml, siteHomeHtml, siteNotFoundHtml, type SiteBuild } from '../../../foundation/runtime/run-site'
import { identity } from '../core/app/identity'
import { run } from './run'

export function sitePages(): SiteBuild {
  return {
    pages: [
      { path: '/', html: siteHomeHtml(identity, run) },
      { path: '/run', html: runPageHtml(identity, run) },
      { path: '/404', html: siteNotFoundHtml(identity, run) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand'],
  }
}
