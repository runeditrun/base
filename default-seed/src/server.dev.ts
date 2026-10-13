// Local-only Worker entry. vite.config.ts loads it only for `vite dev`; the
// deployed main stays src/server.ts, and `rer build` refuses any output that
// contains the dev layer. It adds dev sign-in, personas and the dev badge.
import worker from './server'
import { withDevIdentity } from '../../modules/operator-auth/dev/index.mjs'
import { requireBindings, type Bindings } from './core/platform/bindings.server'
import { authConfig } from './core/platform/auth/config.server'
import { devPersonas } from './core/platform/auth/dev-personas'
import { withDevAi } from '../../modules/ai/dev/index.mjs'

const development = withDevAi<Bindings, typeof worker>(worker, { bindings: requireBindings })
export default withDevIdentity<Bindings, typeof worker>(development, { bindings: requireBindings, config: authConfig, personas: devPersonas })
