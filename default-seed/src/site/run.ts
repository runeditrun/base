// Every string and command on default-seed's Run page. Base is a private
// repository, so this reference names it as a reference only; its run site is
// never deployed (deploy-site.json names a reserved .example domain).
import type { RunData } from '../../../foundation/runtime/run-site'

export const run: RunData = {
  name: 'Default seed',
  repository: 'https://github.com/runeditrun/base',
  clone: 'npx -y @runeditrun/rer dev runeditrun/base',
  folder: 'base/default-seed',
  requirements: 'Runs on macOS, Linux or Windows with WSL2, with git. The installer brings Node when it is missing, and rer brings pnpm.',
  licence: 'MIT',
  docs: false,
  hosted: [],
}
