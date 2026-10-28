// The run site `rer build --site` writes: the homepage with its Run action,
// /run, /docs/hosting, /contract when the seed has a CONTRACT.md, the not-found
// page and the public files they use. It reads no installation data, only
// edition identity, Run data and what rer read from the seed's declarations.
import { contractPageHtml } from '../../../foundation/runtime/contract-page'
import { hostingPageHtml } from '../../../foundation/runtime/hosting-page'
import { runPageHtml, siteHomeHtml, siteNotFoundHtml, type SiteBuild, type SiteContext } from '../../../foundation/runtime/run-site'
import { identity } from '../core/app/identity'
import { run } from './run'

export function sitePages({ contract, hosting }: Partial<SiteContext> = {}): SiteBuild {
  return {
    pages: [
      { path: '/', html: siteHomeHtml(identity, run, contract) },
      { path: '/run', html: runPageHtml(identity, run, contract) },
      // rer supplies hosting (null when the seed does not deploy to Workers); a caller without it gets no hosting page.
      ...(hosting !== undefined ? [{ path: '/docs/hosting', html: hostingPageHtml(identity, run, hosting, contract) }] : []),
      ...(contract ? [{ path: '/contract', html: contractPageHtml(identity, run, contract) }] : []),
      { path: '/404', html: siteNotFoundHtml(identity, run, contract) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand'],
  }
}
