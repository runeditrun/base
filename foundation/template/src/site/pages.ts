// The run site `rer build --site` writes: the homepage with its Run action,
// /run, /docs/hosting, /contract when the seed has a CONTRACT.md, the not-found
// page and the public files they use. Every Run page string and command is in
// run.json; nothing here reads installation data.
import { contractPageHtml } from '../base/contract-page'
import { hostingPageHtml } from '../base/hosting-page'
import { runPageHtml, siteHomeHtml, siteNotFoundHtml, type RunData, type SiteBuild, type SiteContext } from '../base/run-site'
import { identity } from '../identity'
import { runPricing } from '../base/run-pricing'
import run from './run.json'

export function sitePages({ contract, hosting }: Partial<SiteContext> = {}): SiteBuild {
  const data: RunData = { ...run, pricing: runPricing }
  return {
    pages: [
      { path: '/', html: siteHomeHtml(identity, data, contract) },
      { path: '/run', html: runPageHtml(identity, data, contract) },
      // rer supplies hosting (null when the seed does not deploy to Workers); a caller without it gets no hosting page.
      ...(hosting !== undefined ? [{ path: '/docs/hosting', html: hostingPageHtml(identity, data, hosting, contract) }] : []),
      ...(contract ? [{ path: '/contract', html: contractPageHtml(identity, data, contract) }] : []),
      { path: '/404', html: siteNotFoundHtml(identity, data, contract) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand'],
  }
}
