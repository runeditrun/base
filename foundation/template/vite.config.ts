import { seedIcons } from './scripts/base-onboarding/icon-files.mjs'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'
import { resolve } from 'node:path'
import { demoSockets } from './src/modules/demo/vite.mjs'
import { archiveOutputGuard } from './scripts/base-onboarding/archive-output.mjs'
import { excludeLocalVariables } from './scripts/base-onboarding/local-variables-output.mjs'

// Only `vite dev` loads the local-only entry and the checkout's dev key; a build
// keeps src/server.ts and never sees either (rer build checks its output).
const local = (name: string) => process.env[name] ? { [name]: process.env[name] } : {}
const serve = { main: './src/server.dev.ts', vars: { ...local('RER_DEV_ORIGIN'), ...local('RER_DEV_KEY'), ...local('RER_DEV_IDENTITY'), ...local('RER_MODELS_SERVICE'), ...local('RER_MODELS_KEY'), ...local('RER_DEMO'), ...local('RER_DEMO_EXPIRES') } }

// `vite dev` serves only the folders the app is built from (and what they
// import, plus the public run site declaration its identity reads), never the rest of the checkout: not rer's private folders (the dev
// key, installer state), export archives, settings or local data.
const server = { fs: { allow: ['src', 'public', 'node_modules', 'deploy-site.json'], deny: ['**/.rer/**', '**/.seed/**', normalizePath(resolve(process.cwd(), 'exports')) + '/**', '**/*.rer'] } }

export default defineConfig(({ command, isPreview }) => ({ server, plugins: [seedIcons(),demoSockets(), cloudflare({ inspectorPort: false, viteEnvironment: { name: 'ssr' }, persistState: { path: process.env.RER_STATE_DIR ?? '.wrangler/state' }, ...(command === 'serve' && !isPreview ? { config: serve } : process.env.RER_DEV_ORIGIN ? { config: { vars: local('RER_DEV_ORIGIN') } } : {}) }), tanstackStart(), react(), excludeLocalVariables(), archiveOutputGuard()] }))
