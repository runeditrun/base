// Default seed's edition identity: what its installed Lobby and its run site
// say. `deployment` is this installation's own name; an owner edits it here.
import type { EditionIdentity } from '../../../../foundation/runtime/identity'
import site from '../../../deploy-site.json'

// The business's time zone: people read every recorded time in it (foundation/runtime/actor.ts).
export const businessTimeZone = 'Australia/Sydney'

export const identity: EditionIdentity = {
  product: 'Default seed',
  deployment: 'Default seed reference',
  purpose: '{deployment} keeps public records, background jobs and an operator app on one Cloudflare Worker.',
  tagline: 'Public records, background jobs and a signed-in operator app on one Cloudflare Worker.',
  signInPath: '/signin',
  // RER uses the private setup token to claim this owner automatically.
  manualSetupTokenClaim: false,
  // The run site this seed's `rer deploy --site` publishes (deploy-site.json).
  runSite: `https://${site.domain}`,
  // An installed instance serves the Lobby at /.
  installedHome: 'lobby',
  theme: '/rer-theme.css',
  mark: '/brand/mark.svg',
  band: '/brand/band.svg',
  fonts: '/fonts/fonts.css',
  timeZone: businessTimeZone,
}
